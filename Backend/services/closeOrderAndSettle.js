/**
 * closeOrderAndSettle.js
 *
 * Single canonical function for closing an order and settling funds.
 * Used by ALL close paths: manual exit, SL/Target tick, cron squareoff, exit-all.
 *
 * Handles:
 * - Atomic idempotent close (only one caller wins)
 * - Margin release (intraday, overnight, option premium)
 * - Realized P&L calculation with brokerage deduction
 * - P&L booking to pnl_balance (separate from deposited cash)
 * - Ledger transaction entry
 */

import Order from '../Model/Trading/OrdersModel.js';
import Fund from '../Model/FundManagement/FundModel.js';
import { rollbackOptionUsage } from '../Utils/OptionLimitManager.js';
import { releaseMarginOnClose } from './marginLifecycle.js';
import {
  getClientPricingConfig,
  inferPricingBucket,
  getSpreadForBucket,
  applySpreadToPrice,
  calculateBrokerageForLeg,
  getClosingSide,
} from '../Utils/ClientPricingEngine.js';
import { writeAuditFailure, writeAuditSuccess } from '../Utils/AuditLogger.js';

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v) => Number(toNumber(v).toFixed(2));

/**
 * Detect if an order is for options based on symbol
 */
const isOptionOrder = (symbol) => {
  const sym = String(symbol || '').toUpperCase();
  return sym.endsWith('CE') || sym.endsWith('PE') || sym.endsWith('CALL') || sym.endsWith('PUT');
};

/**
 * Close an order and settle funds atomically.
 *
 * @param {string|ObjectId} orderId - The order _id
 * @param {Object} opts
 * @param {number} opts.exitPrice - The exit/close price (LTP at time of close)
 * @param {string} opts.exitReason - One of: manual, stop_loss, target, expiry, square_off
 * @param {string} [opts.cameFrom] - Source: Open, Hold, Overnight, Holdings
 * @returns {{ ok: boolean, order?: Object, pnl?: Object, error?: string }}
 */
export async function closeOrderAndSettle(orderId, { exitPrice, exitReason = 'manual', cameFrom = '' }) {
  try {
    const now = new Date();
    const rawExitInput = toNumber(exitPrice);

    // 1. Atomic idempotent close — only one caller wins
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: { $ne: 'CLOSED' } },
      {
        $set: {
          status: 'CLOSED',
          order_status: 'CLOSED',
          exit_at: now,
          closed_at: now,
          exit_reason: exitReason,
          came_From: cameFrom || undefined,
        }
      },
      { new: true }
    );

    if (!order) {
      return { ok: false, error: 'already_closed_or_not_found' };
    }

    const qty = toNumber(order.quantity);
    const lotSize = Math.max(1, toNumber(order.lot_size) || 1);
    const lots = toNumber(order.lots) > 0 ? toNumber(order.lots) : Math.max(1, qty / lotSize);
    const originalMarginBlocked = toNumber(order.margin_blocked);

    // 2. Resolve pricing context
    const pricingConfig = await getClientPricingConfig({
      brokerIdStr: order.broker_id_str,
      customerIdStr: order.customer_id_str,
    });
    const pricingBucket = order.pricing_bucket || inferPricingBucket({
      exchange: order.exchange,
      segment: order.segment,
      symbol: order.symbol,
      orderType: order.order_type,
    });

    const entryEffectivePrice = toNumber(order.effective_entry_price || order.price);
    const entrySpreadApplied = toNumber(order.entry_spread_applied);
    const inferredRawEntry = entryEffectivePrice - entrySpreadApplied;
    const entryRawPrice = toNumber(
      order.raw_entry_price || inferredRawEntry || entryEffectivePrice
    );

    const fallbackRawExit = toNumber(order.raw_entry_price || order.effective_entry_price || order.price);
    const safeRawExitPrice = rawExitInput > 0 ? rawExitInput : fallbackRawExit;
    const closingSide = getClosingSide(order.side);
    const spreadForBucket = getSpreadForBucket(pricingConfig, pricingBucket);
    const exitPricing = applySpreadToPrice({
      rawPrice: safeRawExitPrice,
      side: closingSide,
      spread: spreadForBucket,
    });
    const effectiveExitPrice = exitPricing.effectivePrice;

    // 2. Calculate realized P&L
    const grossPnl = order.side === 'BUY'
      ? (effectiveExitPrice - entryEffectivePrice) * qty
      : (entryEffectivePrice - effectiveExitPrice) * qty;

    const entryBrokerageInfo = calculateBrokerageForLeg({
      pricing: pricingConfig,
      bucket: pricingBucket,
      side: order.side,
      quantity: qty,
      lots,
      lotSize,
      effectivePrice: entryEffectivePrice,
    });

    const exitBrokerageInfo = calculateBrokerageForLeg({
      pricing: pricingConfig,
      bucket: pricingBucket,
      side: closingSide,
      quantity: qty,
      lots,
      lotSize,
      effectivePrice: effectiveExitPrice,
    });

    const entryBrokerage = toNumber(entryBrokerageInfo.amount);
    const exitBrokerage = toNumber(exitBrokerageInfo.amount);
    const totalBrokerage = entryBrokerage + exitBrokerage;
    const netPnl = grossPnl - totalBrokerage;

    // 3. Update order with P&L
    order.raw_entry_price = round2(entryRawPrice);
    order.effective_entry_price = round2(entryEffectivePrice);
    order.entry_spread_applied = round2(
      toNumber(order.entry_spread_applied, entryEffectivePrice - entryRawPrice)
    );
    order.raw_exit_price = round2(safeRawExitPrice);
    order.effective_exit_price = round2(effectiveExitPrice);
    order.exit_spread_applied = round2(exitPricing.appliedSpread);
    order.exit_price = round2(effectiveExitPrice);
    order.closed_ltp = round2(effectiveExitPrice);
    order.pricing_bucket = pricingBucket;
    order.realized_pnl = round2(netPnl);
    order.brokerage = round2(totalBrokerage);
    order.brokerage_breakdown = {
      entry: entryBrokerageInfo,
      exit: exitBrokerageInfo,
      total: round2(totalBrokerage),
      pricingBucket,
    };

    // 4. Find fund account
    const fund = await Fund.findOne({
      broker_id_str: order.broker_id_str,
      customer_id_str: order.customer_id_str,
    });

    if (!fund) {
      // Order is already closed but funds couldn't be settled
      order.settlement_status = 'failed';
      await order.save();
      console.error(`[closeOrderAndSettle] Fund not found for ${order.customer_id_str}. Order ${orderId} closed but unsettled.`);
      await writeAuditFailure({
        type: 'transaction',
        eventType: 'FUND_PNL_SETTLEMENT',
        category: 'funds',
        message: `Settlement failed: fund not found for customer ${order.customer_id_str}`,
        actor: { type: 'system', id_str: 'SYSTEM', role: 'system' },
        source: 'system',
        target: {
          type: 'customer',
          id: order.customer_id,
          id_str: order.customer_id_str,
        },
        entity: {
          type: 'order',
          id: order._id,
          ref: order.order_id || order._id?.toString(),
        },
        broker: {
          broker_id: order.broker_id,
          broker_id_str: order.broker_id_str,
        },
        customer: {
          customer_id: order.customer_id,
          customer_id_str: order.customer_id_str,
        },
        amountDelta: round2(netPnl),
        note: 'Fund account not found during settlement',
        metadata: {
          settlementStatus: 'failed',
          exitReason,
        },
      });
      return { ok: true, order, pnl: { grossPnl, totalBrokerage, netPnl }, warning: 'fund_not_found' };
    }

    // 5. Release margin from fund (immediate per-order release)
    const marginToRelease = originalMarginBlocked > 0
      ? originalMarginBlocked
      : (entryEffectivePrice * qty);
    const isOption = isOptionOrder(order.symbol);

    if (marginToRelease > 0 && !order.margin_released_at) {
      if (isOption) {
        rollbackOptionUsage(fund, order.product, marginToRelease);
      } else {
        // Immediate release — per-order lifecycle
        releaseMarginOnClose(fund, order, {
          reason: exitReason,
          orderId: String(orderId),
        });
      }
      order.margin_released_at = now;
    }
    order.margin_blocked = 0;

    // 6. Book realized P&L to pnl_balance (separate from deposited cash)
    const beforePnlBalance = toNumber(fund.pnl_balance);
    fund.pnl_balance = toNumber(fund.pnl_balance) + netPnl;
    const afterPnlBalance = toNumber(fund.pnl_balance);

    // 7. Record ledger transaction
    fund.transactions.push({
      type: netPnl >= 0 ? 'realized_profit' : 'realized_loss',
      amount: round2(netPnl),
      notes: `${order.side} ${order.symbol} ${qty}qty | Entry Raw/Eff: ₹${round2(entryRawPrice).toFixed(2)}/₹${round2(entryEffectivePrice).toFixed(2)} Exit Raw/Eff: ₹${round2(safeRawExitPrice).toFixed(2)}/₹${round2(effectiveExitPrice).toFixed(2)} | Gross: ₹${round2(grossPnl).toFixed(2)} Brokerage: ₹${round2(totalBrokerage).toFixed(2)} | Reason: ${exitReason}`,
      status: 'completed',
      reference: String(order._id),
      timestamp: now,
    });

    fund.last_calculated_at = now;

    // 8. Save fund
    try {
      await fund.save();
      order.settlement_status = 'settled';

      await writeAuditSuccess({
        type: 'transaction',
        eventType: 'FUND_PNL_SETTLEMENT',
        category: 'funds',
        message: `Settlement posted for customer ${order.customer_id_str}`,
        actor: { type: 'system', id_str: 'SYSTEM', role: 'system' },
        source: 'system',
        target: {
          type: 'customer',
          id: order.customer_id,
          id_str: order.customer_id_str,
        },
        entity: {
          type: 'order',
          id: order._id,
          ref: order.order_id || order._id?.toString(),
        },
        broker: {
          broker_id: order.broker_id,
          broker_id_str: order.broker_id_str,
        },
        customer: {
          customer_id: order.customer_id,
          customer_id_str: order.customer_id_str,
        },
        amountDelta: round2(netPnl),
        fundBefore: {
          pnlBalance: beforePnlBalance,
        },
        fundAfter: {
          pnlBalance: afterPnlBalance,
        },
        note: `Settlement reason: ${exitReason}`,
        metadata: {
          orderSymbol: order.symbol,
          side: order.side,
          quantity: qty,
          grossPnl: round2(grossPnl),
          brokerage: round2(totalBrokerage),
          netPnl: round2(netPnl),
          settlementStatus: 'settled',
        },
      });
    } catch (fundErr) {
      console.error(`[closeOrderAndSettle] Fund save failed for order ${orderId}:`, fundErr.message);
      order.settlement_status = 'failed';

      await writeAuditFailure({
        type: 'transaction',
        eventType: 'FUND_PNL_SETTLEMENT',
        category: 'funds',
        message: `Settlement failed while saving fund for customer ${order.customer_id_str}`,
        actor: { type: 'system', id_str: 'SYSTEM', role: 'system' },
        source: 'system',
        target: {
          type: 'customer',
          id: order.customer_id,
          id_str: order.customer_id_str,
        },
        entity: {
          type: 'order',
          id: order._id,
          ref: order.order_id || order._id?.toString(),
        },
        broker: {
          broker_id: order.broker_id,
          broker_id_str: order.broker_id_str,
        },
        customer: {
          customer_id: order.customer_id,
          customer_id_str: order.customer_id_str,
        },
        amountDelta: round2(netPnl),
        note: 'Fund save failed during settlement',
        metadata: {
          error: fundErr.message,
          settlementStatus: 'failed',
          grossPnl: round2(grossPnl),
          brokerage: round2(totalBrokerage),
          netPnl: round2(netPnl),
        },
      });
    }

    // 9. Save order with settlement status + P&L
    await order.save();

    console.log(`[closeOrderAndSettle] Order ${orderId} closed. ${order.symbol} ${order.side} ${qty}qty | Raw Exit: ₹${round2(safeRawExitPrice)} Eff Exit: ₹${round2(effectiveExitPrice)} | Net P&L: ₹${round2(netPnl)} | Settlement: ${order.settlement_status}`);

    return {
      ok: true,
      order,
      pnl: {
        rawEntryPrice: round2(entryRawPrice),
        effectiveEntryPrice: round2(entryEffectivePrice),
        rawExitPrice: round2(safeRawExitPrice),
        effectiveExitPrice: round2(effectiveExitPrice),
        grossPnl: round2(grossPnl),
        totalBrokerage: round2(totalBrokerage),
        netPnl: round2(netPnl),
      },
    };
  } catch (err) {
    console.error(`[closeOrderAndSettle] Error closing order ${orderId}:`, err.message);
    return { ok: false, error: err.message };
  }
}
