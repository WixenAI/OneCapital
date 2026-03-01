import cron from 'node-cron';
import Fund from '../../Model/FundManagement/FundModel.js';
import Order from '../../Model/Trading/OrdersModel.js';
import { writeAuditSuccess } from '../../Utils/AuditLogger.js';
import { withLock } from '../../services/cronLock.js';

const toNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(toNumber(v).toFixed(2));

const ACTIVE_STATUSES = ['OPEN', 'EXECUTED', 'HOLD', 'PENDING'];
const INTRADAY_PRODUCTS = ['MIS'];
const DELIVERY_PRODUCTS = ['CNC', 'NRML'];

/**
 * Reconcile fund margin for a single customer.
 * Recomputes expected intraday/delivery used values from active orders,
 * corrects any drift, and logs corrections.
 *
 * @param {Object} fund - Mongoose fund document (mutated in-memory; caller must save)
 * @returns {{ intradayFixed: boolean, deliveryFixed: boolean }}
 */
async function reconcileFundMargin(fund) {
  const { customer_id_str, broker_id_str } = fund;

  // Compute expected intraday used from active MIS non-option orders
  const activeMisOrders = await Order.find({
    customer_id_str,
    broker_id_str,
    product: { $in: INTRADAY_PRODUCTS },
    status: { $in: ACTIVE_STATUSES },
  }).select('margin_blocked symbol').lean();

  const expectedIntradayUsed = round2(
    activeMisOrders.reduce((sum, o) => sum + toNumber(o.margin_blocked), 0)
  );

  // Compute expected delivery used from active CNC/NRML non-option orders
  const activeDeliveryOrders = await Order.find({
    customer_id_str,
    broker_id_str,
    product: { $in: DELIVERY_PRODUCTS },
    status: { $in: ACTIVE_STATUSES },
  }).select('margin_blocked symbol').lean();

  const expectedDeliveryUsed = round2(
    activeDeliveryOrders.reduce((sum, o) => sum + toNumber(o.margin_blocked), 0)
  );

  const currentIntradayUsed = round2(toNumber(fund.intraday?.used_limit));
  const currentDeliveryUsed = round2(toNumber(fund.delivery?.used_limit));

  let intradayFixed = false;
  let deliveryFixed = false;

  // Fix intraday drift
  if (currentIntradayUsed !== expectedIntradayUsed) {
    const drift = round2(currentIntradayUsed - expectedIntradayUsed);
    console.log(`[CRON] Reconcile intraday ${customer_id_str}: was ₹${currentIntradayUsed}, expected ₹${expectedIntradayUsed} (drift ₹${drift})`);

    fund.intraday.used_limit = expectedIntradayUsed;
    fund.transactions.push({
      type: 'margin_reconcile_intraday',
      amount: round2(Math.abs(drift)),
      notes: `Midnight reconcile: intraday corrected from ₹${currentIntradayUsed} to ₹${expectedIntradayUsed} (drift ₹${drift}) | ${activeMisOrders.length} active MIS orders`,
      status: 'completed',
      timestamp: new Date(),
    });
    intradayFixed = true;
  }

  // Fix delivery drift + overnight available
  if (currentDeliveryUsed !== expectedDeliveryUsed) {
    const drift = round2(currentDeliveryUsed - expectedDeliveryUsed);
    const overnightAdjustment = drift; // if delivery was over-locked, overnight was under-available
    console.log(`[CRON] Reconcile delivery ${customer_id_str}: was ₹${currentDeliveryUsed}, expected ₹${expectedDeliveryUsed} (drift ₹${drift})`);

    fund.delivery.used_limit = expectedDeliveryUsed;
    fund.overnight.available_limit = round2(toNumber(fund.overnight.available_limit) + overnightAdjustment);

    fund.transactions.push({
      type: 'margin_reconcile_delivery',
      amount: round2(Math.abs(drift)),
      notes: `Midnight reconcile: delivery corrected from ₹${currentDeliveryUsed} to ₹${expectedDeliveryUsed} (drift ₹${drift}) | ${activeDeliveryOrders.length} active delivery orders`,
      status: 'completed',
      timestamp: new Date(),
    });
    deliveryFixed = true;
  }

  if (intradayFixed || deliveryFixed) {
    fund.last_calculated_at = new Date();
  }

  return { intradayFixed, deliveryFixed };
}

const FundCronJobs = () => {

    // ---------------------------------------------------------
    // Job: Midnight Margin Reconciliation at 12:05 AM IST
    // Runs AFTER squareoff cron (12:02 AM).
    // Replaces the old blanket intraday/option reset.
    // Corrects any drift between fund buckets and active orders.
    // ---------------------------------------------------------
    cron.schedule('5 0 * * *', async () => {
        await withLock('cron:fund:midnight-reconcile-0005', 480, async () => {
            console.log('[CRON] Running Midnight Margin Reconciliation (00:05 IST)...');

            try {
                const allFunds = await Fund.find({}).select(
                  '_id customer_id_str broker_id_str intraday delivery overnight transactions last_calculated_at option_premium_used option_limit'
                );

                let intradayFixedCount = 0;
                let deliveryFixedCount = 0;
                let cleanCount = 0;

                for (const fund of allFunds) {
                    try {
                        const { intradayFixed, deliveryFixed } = await reconcileFundMargin(fund);

                        if (intradayFixed || deliveryFixed) {
                            await fund.save();
                            if (intradayFixed) intradayFixedCount++;
                            if (deliveryFixed) deliveryFixedCount++;
                        } else {
                            cleanCount++;
                        }
                    } catch (fundErr) {
                        console.error(`[CRON] Reconcile failed for fund ${fund._id} (${fund.customer_id_str}):`, fundErr.message);
                    }
                }

                console.log(`[CRON] Reconciliation done: ${intradayFixedCount} intraday corrected, ${deliveryFixedCount} delivery corrected, ${cleanCount} clean.`);

                await writeAuditSuccess({
                    type: 'system',
                    eventType: 'MARGIN_RECONCILE_MIDNIGHT',
                    category: 'margin',
                    message: 'Midnight margin reconciliation completed',
                    actor: { type: 'system', id_str: 'SYSTEM', role: 'system' },
                    source: 'cron',
                    note: 'Per-order lifecycle reconciliation pass',
                    metadata: {
                        totalFunds: allFunds.length,
                        intradayFixedCount,
                        deliveryFixedCount,
                        cleanCount,
                    },
                });

            } catch (error) {
                console.error("[CRON] Error in midnight margin reconciliation:", error);
            }
        });
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });
};

export default FundCronJobs;
