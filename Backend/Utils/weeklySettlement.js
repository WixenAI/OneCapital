const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const toValidDate = (value) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};

const getIstClockDate = (utcDate = new Date()) => {
  const safeUtcDate = toValidDate(utcDate) || new Date();
  return new Date(safeUtcDate.getTime() + IST_OFFSET_MS);
};

const getMondayStartIstUtc = (nowUtc = new Date()) => {
  const istClock = getIstClockDate(nowUtc);
  const istWeekday = istClock.getUTCDay(); // 0=Sun ... 6=Sat in IST clock-space
  const daysSinceMonday = (istWeekday + 6) % 7;

  const mondayIstClock = new Date(istClock);
  mondayIstClock.setUTCHours(0, 0, 0, 0);
  mondayIstClock.setUTCDate(mondayIstClock.getUTCDate() - daysSinceMonday);

  return new Date(mondayIstClock.getTime() - IST_OFFSET_MS);
};

const getIstWeekRangeFromDate = (nowUtc = new Date()) => {
  const weekStartUtc = getMondayStartIstUtc(nowUtc);
  const weekEndUtc = new Date(weekStartUtc.getTime() + WEEK_MS);
  return { weekStartUtc, weekEndUtc };
};

const parseSettlementMetadataFromNotes = (notes) => {
  const raw = String(notes || '').trim();
  if (!raw) return null;

  const parseJson = (input) => {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } catch {
      return null;
    }
  };

  const direct = parseJson(raw);
  if (direct) return direct;

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return parseJson(jsonMatch[0]);
};

const buildSettlementMetadataNotes = ({
  mode = 'manual',
  weekStartUtc,
  weekEndUtc,
  settledAtUtc,
  brokerIdStr = '',
  brokerId = '',
  customerIdStr = '',
  runRef = '',
  note = '',
} = {}) => {
  const payload = {
    event: 'weekly_settlement',
    version: 1,
    mode,
    weekStart: weekStartUtc ? new Date(weekStartUtc).toISOString() : '',
    weekEnd: weekEndUtc ? new Date(weekEndUtc).toISOString() : '',
    settledAt: settledAtUtc ? new Date(settledAtUtc).toISOString() : new Date().toISOString(),
    brokerIdStr: String(brokerIdStr || ''),
    brokerId: String(brokerId || ''),
    customerIdStr: String(customerIdStr || ''),
    runRef: String(runRef || ''),
    note: String(note || ''),
  };
  return JSON.stringify(payload);
};

const toSettlementRow = (transaction) => {
  if (!transaction || String(transaction.type || '').toLowerCase() !== 'weekly_settlement') return null;
  const timestamp = toValidDate(transaction.timestamp || transaction.createdAt);
  if (!timestamp) return null;

  return {
    transaction,
    timestamp,
    metadata: parseSettlementMetadataFromNotes(transaction.notes),
  };
};

const getLatestWeeklySettlement = (transactions = [], predicate = null) => {
  let latest = null;
  for (const tx of transactions || []) {
    const row = toSettlementRow(tx);
    if (!row) continue;
    if (typeof predicate === 'function' && !predicate(row)) continue;
    if (!latest || row.timestamp > latest.timestamp) latest = row;
  }
  return latest;
};

const hasSettlementInWeekRange = ({ transactions = [], weekStartUtc, weekEndUtc }) => {
  const start = toValidDate(weekStartUtc);
  const end = toValidDate(weekEndUtc);
  if (!start || !end) return null;
  return getLatestWeeklySettlement(transactions, ({ timestamp }) => timestamp >= start && timestamp < end);
};

const resolveCurrentWeeklyBoundary = ({ transactions = [], nowUtc = new Date() } = {}) => {
  const safeNow = toValidDate(nowUtc) || new Date();
  const { weekStartUtc, weekEndUtc } = getIstWeekRangeFromDate(safeNow);

  const latestThisWeek = hasSettlementInWeekRange({
    transactions,
    weekStartUtc,
    weekEndUtc,
  });

  if (!latestThisWeek) {
    return {
      boundaryStartUtc: weekStartUtc,
      boundaryType: 'auto_monday',
      weekStartUtc,
      weekEndUtc,
      latestSettlement: null,
    };
  }

  const mode = String(latestThisWeek.metadata?.mode || '').toLowerCase();
  const boundaryType = mode === 'auto' ? 'auto_monday' : 'manual_settlement';

  return {
    boundaryStartUtc: latestThisWeek.timestamp,
    boundaryType,
    weekStartUtc,
    weekEndUtc,
    latestSettlement: latestThisWeek,
  };
};

const createSettlementReference = (dateUtc = new Date()) => {
  const istClock = getIstClockDate(dateUtc);
  const y = istClock.getUTCFullYear();
  const m = String(istClock.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istClock.getUTCDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `WS-${y}${m}${d}-${rand}`;
};

export {
  round2,
  toValidDate,
  getMondayStartIstUtc,
  getIstWeekRangeFromDate,
  parseSettlementMetadataFromNotes,
  buildSettlementMetadataNotes,
  getLatestWeeklySettlement,
  hasSettlementInWeekRange,
  resolveCurrentWeeklyBoundary,
  createSettlementReference,
};
