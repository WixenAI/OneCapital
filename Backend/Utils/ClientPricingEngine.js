import ClientPricingModel from '../Model/Trading/ClientPricingModel.js';

export const DEFAULT_CLIENT_PRICING = Object.freeze({
  brokerage: {
    cash_future: {
      mode: 'PERCENT',
      buy: 0.08,
      sell: 0.08,
    },
    options: {
      buy_per_lot: 2,
      sell_per_lot: 2,
    },
  },
  spread: {
    cash: 0,
    future: 0,
    option: 0,
    mcx: 0,
  },
});

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = (value) => Number(toNumber(value).toFixed(2));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeMode = (value) => {
  const mode = String(value || '').toUpperCase();
  return mode === 'FLAT_PER_UNIT' ? 'FLAT_PER_UNIT' : 'PERCENT';
};

const normalizeSide = (side) => (String(side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY');

const normalizeSpread = (spread = {}) => ({
  cash: clamp(toNumber(spread.cash, DEFAULT_CLIENT_PRICING.spread.cash), -1000, 1000),
  future: clamp(toNumber(spread.future, DEFAULT_CLIENT_PRICING.spread.future), -1000, 1000),
  option: clamp(toNumber(spread.option, DEFAULT_CLIENT_PRICING.spread.option), -1000, 1000),
  mcx: clamp(toNumber(spread.mcx, DEFAULT_CLIENT_PRICING.spread.mcx), -1000, 1000),
});

const normalizeBrokerage = (brokerage = {}) => {
  const cashFuture = brokerage.cash_future || {};
  const optionRules = brokerage.options || {};
  const mode = normalizeMode(cashFuture.mode);

  return {
    cash_future: {
      mode,
      buy: clamp(
        toNumber(cashFuture.buy, DEFAULT_CLIENT_PRICING.brokerage.cash_future.buy),
        0,
        mode === 'PERCENT' ? 100 : 100000
      ),
      sell: clamp(
        toNumber(cashFuture.sell, DEFAULT_CLIENT_PRICING.brokerage.cash_future.sell),
        0,
        mode === 'PERCENT' ? 100 : 100000
      ),
    },
    options: {
      buy_per_lot: clamp(
        toNumber(optionRules.buy_per_lot, DEFAULT_CLIENT_PRICING.brokerage.options.buy_per_lot),
        0,
        100000
      ),
      sell_per_lot: clamp(
        toNumber(optionRules.sell_per_lot, DEFAULT_CLIENT_PRICING.brokerage.options.sell_per_lot),
        0,
        100000
      ),
    },
  };
};

export const normalizeClientPricing = (pricing = {}) => ({
  brokerage: normalizeBrokerage(pricing.brokerage),
  spread: normalizeSpread(pricing.spread),
});

export const getClientPricingConfig = async ({ brokerIdStr, customerIdStr }) => {
  if (!brokerIdStr || !customerIdStr) {
    return normalizeClientPricing(DEFAULT_CLIENT_PRICING);
  }

  const doc = await ClientPricingModel.findOne({
    broker_id_str: String(brokerIdStr),
    customer_id_str: String(customerIdStr),
  }).lean();

  if (!doc) return normalizeClientPricing(DEFAULT_CLIENT_PRICING);

  return normalizeClientPricing({
    brokerage: doc.brokerage,
    spread: doc.spread,
  });
};

export const inferPricingBucket = ({ exchange, segment, symbol, orderType }) => {
  const ex = String(exchange || '').toUpperCase();
  const seg = String(segment || '').toUpperCase();
  const sym = String(symbol || '').toUpperCase();
  const ordType = String(orderType || '').toUpperCase();

  if (ex.includes('MCX') || seg.includes('MCX')) return 'MCX';

  const isOption =
    sym.endsWith('CE') ||
    sym.endsWith('PE') ||
    sym.endsWith('CALL') ||
    sym.endsWith('PUT') ||
    seg.includes('OPT') ||
    ordType === 'OPTION_CHAIN';
  if (isOption) return 'OPTION';

  const isFuture =
    sym.includes('FUT') ||
    seg.includes('FUT') ||
    seg.includes('NFO') ||
    seg.includes('F&O') ||
    seg === 'FO' ||
    seg === 'NRML';
  if (isFuture) return 'FUTURE';

  return 'CASH';
};

export const getSpreadForBucket = (pricing, bucket) => {
  const spread = pricing?.spread || DEFAULT_CLIENT_PRICING.spread;
  const key = String(bucket || 'CASH').toUpperCase();
  if (key === 'MCX') return toNumber(spread.mcx, 0);
  if (key === 'OPTION') return toNumber(spread.option, 0);
  if (key === 'FUTURE') return toNumber(spread.future, 0);
  return toNumber(spread.cash, 0);
};

export const applySpreadToPrice = ({ rawPrice, side, spread }) => {
  const safeRaw = toNumber(rawPrice, 0);
  const safeSpread = toNumber(spread, 0);
  const normalizedSide = normalizeSide(side);
  const appliedSpread = normalizedSide === 'BUY' ? safeSpread : -safeSpread;
  const effectivePrice = round2(safeRaw + appliedSpread);

  return {
    rawPrice: round2(safeRaw),
    effectivePrice,
    appliedSpread: round2(appliedSpread),
  };
};

export const getClosingSide = (entrySide) => (normalizeSide(entrySide) === 'BUY' ? 'SELL' : 'BUY');

export const resolveLots = ({ lots, quantity, lotSize }) => {
  const qty = toNumber(quantity, 0);
  const lot = Math.max(1, toNumber(lotSize, 1));
  const inputLots = toNumber(lots, 0);

  if (inputLots > 0) return inputLots;
  if (qty > 0) return Math.max(1, qty / lot);
  return 1;
};

export const calculateBrokerageForLeg = ({
  pricing,
  bucket,
  side,
  quantity,
  lotSize,
  lots,
  effectivePrice,
}) => {
  const normalizedSide = normalizeSide(side);
  const normalizedBucket = String(bucket || 'CASH').toUpperCase();
  const qty = Math.max(0, toNumber(quantity, 0));
  const price = Math.max(0, toNumber(effectivePrice, 0));
  const resolvedLots = resolveLots({ lots, quantity: qty, lotSize });

  // Options use fixed per-lot brokerage.
  if (normalizedBucket === 'OPTION') {
    const perLot =
      normalizedSide === 'BUY'
        ? toNumber(pricing?.brokerage?.options?.buy_per_lot, DEFAULT_CLIENT_PRICING.brokerage.options.buy_per_lot)
        : toNumber(pricing?.brokerage?.options?.sell_per_lot, DEFAULT_CLIENT_PRICING.brokerage.options.sell_per_lot);

    return {
      amount: round2(perLot * resolvedLots),
      mode: 'FLAT_PER_LOT',
      rate: round2(perLot),
      basis: round2(resolvedLots),
      side: normalizedSide,
    };
  }

  // Cash/Future/MCX use cash_future rules.
  const cfMode = normalizeMode(pricing?.brokerage?.cash_future?.mode);
  const sideRate =
    normalizedSide === 'BUY'
      ? toNumber(pricing?.brokerage?.cash_future?.buy, DEFAULT_CLIENT_PRICING.brokerage.cash_future.buy)
      : toNumber(pricing?.brokerage?.cash_future?.sell, DEFAULT_CLIENT_PRICING.brokerage.cash_future.sell);

  if (cfMode === 'FLAT_PER_UNIT') {
    return {
      amount: round2(qty * sideRate),
      mode: 'FLAT_PER_UNIT',
      rate: round2(sideRate),
      basis: round2(qty),
      side: normalizedSide,
    };
  }

  const turnover = qty * price;
  return {
    amount: round2((turnover * sideRate) / 100),
    mode: 'PERCENT',
    rate: round2(sideRate),
    basis: round2(turnover),
    side: normalizedSide,
  };
};

