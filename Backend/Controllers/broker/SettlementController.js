import asyncHandler from 'express-async-handler';
import FundModel from '../../Model/FundManagement/FundModel.js';
import {
  parseSettlementMetadataFromNotes,
} from '../../Utils/weeklySettlement.js';
import { runWeeklySettlementForBroker } from '../../services/weeklySettlementService.js';

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const getBrokerContext = (req) => ({
  brokerId: req.user?._id,
  brokerIdStr: req.user?.login_id || req.user?.stringBrokerId || req.user?.broker_id || '',
});

/**
 * @desc     Run weekly settlement manually for broker clients
 * @route    POST /api/broker/settlement/weekly/run
 * @access   Private (Broker only)
 */
const runWeeklySettlement = asyncHandler(async (req, res) => {
  const { brokerId, brokerIdStr } = getBrokerContext(req);
  if (!brokerIdStr) {
    return res.status(400).json({
      success: false,
      message: 'Broker identifier missing for settlement.',
    });
  }

  const { effectiveAt, note = '', force = false } = req.body || {};
  const summary = await runWeeklySettlementForBroker({
    brokerId,
    brokerIdStr,
    mode: 'manual',
    effectiveAt: effectiveAt || new Date(),
    note,
    force: Boolean(force),
    req,
  });

  res.status(200).json({
    success: true,
    message: summary.created > 0
      ? 'Weekly settlement completed.'
      : 'No new settlements created for this week.',
    settlement: summary,
  });
});

/**
 * @desc     Get weekly settlement history grouped by settlement run reference
 * @route    GET /api/broker/settlement/weekly/history
 * @access   Private (Broker only)
 */
const getWeeklySettlementHistory = asyncHandler(async (req, res) => {
  const { brokerIdStr } = getBrokerContext(req);
  if (!brokerIdStr) {
    return res.status(400).json({
      success: false,
      message: 'Broker identifier missing for settlement history.',
    });
  }

  const page = toPositiveInt(req.query.page, 1);
  const limit = Math.min(toPositiveInt(req.query.limit, 20), 100);
  const skip = (page - 1) * limit;

  const basePipeline = [
    { $match: { broker_id_str: brokerIdStr } },
    { $unwind: '$transactions' },
    {
      $match: {
        'transactions.type': 'weekly_settlement',
        'transactions.reference': { $exists: true, $ne: '' },
      },
    },
    {
      $project: {
        customer_id_str: 1,
        reference: '$transactions.reference',
        amount: '$transactions.amount',
        timestamp: '$transactions.timestamp',
        notes: '$transactions.notes',
      },
    },
  ];

  const [rows, countRows] = await Promise.all([
    FundModel.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: '$reference',
          settledAt: { $max: '$timestamp' },
          totalAmount: { $sum: { $ifNull: ['$amount', 0] } },
          customersAffected: { $sum: 1 },
          customers: { $addToSet: '$customer_id_str' },
          notes: { $first: '$notes' },
        },
      },
      { $sort: { settledAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    FundModel.aggregate([
      ...basePipeline,
      { $group: { _id: '$reference' } },
      { $count: 'total' },
    ]),
  ]);

  const total = Number(countRows?.[0]?.total || 0);

  const history = rows.map((row) => {
    const metadata = parseSettlementMetadataFromNotes(row.notes) || {};
    return {
      runRef: row._id,
      settledAt: row.settledAt,
      mode: metadata.mode || 'manual',
      weekStart: metadata.weekStart || null,
      weekEnd: metadata.weekEnd || null,
      note: metadata.note || '',
      customersAffected: Number(row.customersAffected || 0),
      totalAmount: Number(row.totalAmount || 0),
      customersPreview: Array.isArray(row.customers) ? row.customers.slice(0, 5) : [],
    };
  });

  res.status(200).json({
    success: true,
    history,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

export {
  runWeeklySettlement,
  getWeeklySettlementHistory,
};
