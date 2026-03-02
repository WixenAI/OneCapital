import BrokerModel from '../Model/Auth/BrokerModel.js';
import FundModel from '../Model/FundManagement/FundModel.js';
import { writeAuditFailure, writeAuditSuccess } from '../Utils/AuditLogger.js';
import {
  buildSettlementMetadataNotes,
  createSettlementReference,
  getIstWeekRangeFromDate,
  hasSettlementInWeekRange,
  round2,
  toValidDate,
} from '../Utils/weeklySettlement.js';

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const shouldRunAutoSettlement = (broker) => {
  const configured = broker?.settings?.settlement?.auto_weekly_settlement_enabled;
  if (configured === undefined || configured === null) return true;
  return Boolean(configured);
};

const runWeeklySettlementForBroker = async ({
  brokerId,
  brokerIdStr,
  mode = 'manual',
  effectiveAt = new Date(),
  note = '',
  force = false,
  req = null,
} = {}) => {
  const safeEffectiveAt = toValidDate(effectiveAt);
  if (!safeEffectiveAt) {
    throw new Error('Invalid effectiveAt date for weekly settlement.');
  }
  if (!brokerIdStr) {
    throw new Error('brokerIdStr is required for weekly settlement.');
  }

  const { weekStartUtc, weekEndUtc } = getIstWeekRangeFromDate(safeEffectiveAt);
  const runRef = createSettlementReference(safeEffectiveAt);

  const funds = await FundModel.find({ broker_id_str: brokerIdStr })
    .select('_id customer_id customer_id_str broker_id_str pnl_balance transactions last_calculated_at');

  let created = 0;
  let skippedExisting = 0;
  let failed = 0;
  const errors = [];

  for (const fund of funds) {
    try {
      if (!Array.isArray(fund.transactions)) fund.transactions = [];

      const existingInWeek = hasSettlementInWeekRange({
        transactions: fund.transactions,
        weekStartUtc,
        weekEndUtc,
      });

      if (existingInWeek && !force) {
        skippedExisting += 1;
        continue;
      }

      fund.transactions.push({
        type: 'weekly_settlement',
        amount: round2(toNumber(fund.pnl_balance)),
        notes: buildSettlementMetadataNotes({
          mode,
          weekStartUtc,
          weekEndUtc,
          settledAtUtc: safeEffectiveAt,
          brokerIdStr,
          brokerId: brokerId || '',
          customerIdStr: fund.customer_id_str || '',
          runRef,
          note,
        }),
        status: 'completed',
        reference: runRef,
        processedBy: brokerId || undefined,
        timestamp: safeEffectiveAt,
      });
      fund.last_calculated_at = safeEffectiveAt;

      await fund.save();
      created += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        fundId: fund._id?.toString?.() || '',
        customerIdStr: fund.customer_id_str || '',
        error: error?.message || String(error),
      });
    }
  }

  const summary = {
    runRef,
    mode,
    weekStart: weekStartUtc.toISOString(),
    weekEnd: weekEndUtc.toISOString(),
    settledAt: safeEffectiveAt.toISOString(),
    totalFunds: funds.length,
    created,
    skippedExisting,
    failed,
    force: Boolean(force),
    note: String(note || ''),
    errors,
  };

  await writeAuditSuccess({
    req,
    type: 'transaction',
    eventType: 'WEEKLY_SETTLEMENT_RUN',
    category: 'funds',
    message: `Weekly settlement run (${mode}) for broker ${brokerIdStr}`,
    broker: {
      broker_id: brokerId,
      broker_id_str: brokerIdStr,
    },
    metadata: summary,
    note: note || `Weekly settlement run (${mode})`,
    source: req ? 'api' : 'system',
  });

  if (failed > 0) {
    await writeAuditFailure({
      req,
      type: 'transaction',
      eventType: 'WEEKLY_SETTLEMENT_PARTIAL_FAILURE',
      category: 'funds',
      message: `Weekly settlement completed with failures for broker ${brokerIdStr}`,
      broker: {
        broker_id: brokerId,
        broker_id_str: brokerIdStr,
      },
      metadata: {
        runRef,
        failed,
        errors,
      },
      note: 'Some fund documents failed during weekly settlement',
      source: req ? 'api' : 'system',
    });
  }

  return summary;
};

const runAutoWeeklySettlementForAllBrokers = async ({ effectiveAt = new Date() } = {}) => {
  const brokers = await BrokerModel.find({})
    .select('_id broker_id settings status');

  const summary = {
    totalBrokers: brokers.length,
    attempted: 0,
    skipped: 0,
    failed: 0,
    runs: [],
  };

  for (const broker of brokers) {
    if (String(broker.status || '').toLowerCase() === 'blocked') {
      summary.skipped += 1;
      continue;
    }

    if (!shouldRunAutoSettlement(broker)) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;
    try {
      const run = await runWeeklySettlementForBroker({
        brokerId: broker._id,
        brokerIdStr: broker.broker_id,
        mode: 'auto',
        effectiveAt,
        note: 'Auto weekly settlement (Monday 00:00 IST)',
        force: false,
        req: null,
      });
      summary.runs.push({
        brokerIdStr: broker.broker_id,
        ...run,
      });
    } catch (error) {
      summary.failed += 1;
      summary.runs.push({
        brokerIdStr: broker.broker_id,
        error: error?.message || String(error),
      });
    }
  }

  return summary;
};

export {
  runWeeklySettlementForBroker,
  runAutoWeeklySettlementForAllBrokers,
};
