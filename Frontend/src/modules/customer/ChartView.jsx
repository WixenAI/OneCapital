import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../../api';
import { useMarketData } from '../../context/SocketContext';
import OrderBottomSheet from './OrderBottomSheet';
import TradingChart from '../../components/charts/TradingChart';
import useCustomerTradingGate from '../../hooks/useCustomerTradingGate';

const TIMEFRAMES = [
  { key: '1D', label: '1D', type: 'intraday', interval: '5' },
  { key: '1W', label: '1W', type: 'day' },
  { key: '1M', label: '1M', type: 'day' },
  { key: '1Y', label: '1Y', type: 'day' },
  { key: 'ALL', label: 'All', type: 'day' },
];

const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const IST_HEADER_TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const pad = (value) => String(value).padStart(2, '0');

const toIstPseudoDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + IST_OFFSET_MS);
};

const formatDate = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const formatDateTime = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return `${formatDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const getRangeForTimeframe = (timeframe) => {
  const now = toIstPseudoDate();
  if (timeframe === '1D') {
    const sessionStart = new Date(now);
    sessionStart.setUTCHours(9, 15, 0, 0);

    const sessionEnd = new Date(now);
    sessionEnd.setUTCHours(15, 30, 0, 0);

    let from = sessionStart;
    let to = now < sessionEnd ? now : sessionEnd;

    if (now < sessionStart) {
      from = new Date(sessionStart);
      from.setUTCDate(from.getUTCDate() - 1);

      to = new Date(sessionEnd);
      to.setUTCDate(to.getUTCDate() - 1);
    }

    return { from: formatDateTime(from), to: formatDateTime(to), type: 'intraday' };
  }
  if (timeframe === '1W') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 7);
    return { from: formatDate(start), to: formatDate(now), type: 'day' };
  }
  if (timeframe === '1M') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 30);
    return { from: formatDate(start), to: formatDate(now), type: 'day' };
  }
  if (timeframe === '1Y') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 365);
    return { from: formatDate(start), to: formatDate(now), type: 'day' };
  }
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  return { from: formatDate(start), to: formatDate(now), type: 'day' };
};

const toNumber = (value) => (value == null ? null : Number(value));

const ChartView = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { subscribe, unsubscribe, ticksRef, tickUpdatedAtRef } = useMarketData();
  const { isCustomerTradeAllowed, marketClosedReason } = useCustomerTradingGate();

  const state = location.state || {};
  const stock = state.stock || null;
  const ltpData = state.ltpData || null;

  const instrumentToken = stock?.instrumentToken || stock?.instrument_token || null;
  const symbol = stock?.symbol || stock?.tradingsymbol || stock?.name || '';
  const exchange = stock?.exchange || stock?.segment || 'NSE';
  const isOption = useMemo(() => {
    const segment = String(stock?.segment || stock?.exchange || '').toUpperCase();
    return segment.includes('OPT');
  }, [stock]);

  const [timeframe, setTimeframe] = useState('1D');
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [liveTick, setLiveTick] = useState(null);
  const [orderSheet, setOrderSheet] = useState({ open: false, side: 'BUY' });

  useEffect(() => {
    if (!instrumentToken) return undefined;
    const list = [{ instrument_token: instrumentToken }];
    subscribe(list, 'full');
    return () => unsubscribe(list, 'full');
  }, [instrumentToken, subscribe, unsubscribe]);

  useEffect(() => {
    if (!instrumentToken) return undefined;

    let animationFrameId;
    let lastUpdate = 0;
    const THROTTLE_MS = 120;

    const updateLoop = (timestamp) => {
      if (timestamp - lastUpdate < THROTTLE_MS) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      const tick = ticksRef.current.get(String(instrumentToken));
      if (tick) {
        setLiveTick(tick);
        lastUpdate = timestamp;
      }

      animationFrameId = requestAnimationFrame(updateLoop);
    };

    animationFrameId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [instrumentToken, ticksRef]);

  useEffect(() => {
    if (!instrumentToken) return;
    const { from, to, type } = getRangeForTimeframe(timeframe);
    const controller = new AbortController();
    let isActive = true;

    const fetchChart = async () => {
      setLoading(true);
      setError(null);
      try {
        if (type === 'intraday') {
          const response = await api.get('/chart/getIntradayData', {
            params: {
              instrument_token: instrumentToken,
              from,
              to,
              interval: '5',
            },
            signal: controller.signal,
          });
          if (!isActive) return;
          setCandles(response?.data?.data?.candles || []);
        } else {
          const response = await api.get('/chart/getChartData', {
            params: {
              instrument_token: instrumentToken,
              from,
              to,
              interval: 'day',
            },
            signal: controller.signal,
          });
          if (!isActive) return;
          setCandles(response?.data?.data?.candles || []);
        }
      } catch (err) {
        if (controller.signal.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') {
          return;
        }
        if (!isActive) return;
        setError(err?.message || 'Failed to load chart data');
        setCandles([]);
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    fetchChart();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [instrumentToken, timeframe]);

  const chartStats = useMemo(() => {
    if (!candles.length) {
      return {
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
        avg: null,
      };
    }

    const opens = candles[0]?.[1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let close = candles[candles.length - 1]?.[4];
    let sumClose = 0;

    candles.forEach((candle) => {
      const [, , highVal, lowVal, closeVal, vol] = candle;
      high = Math.max(high, highVal);
      low = Math.min(low, lowVal);
      sumClose += closeVal;
      volume += vol || 0;
    });

    return {
      open: opens,
      high,
      low,
      close,
      volume,
      avg: candles.length ? sumClose / candles.length : null,
    };
  }, [candles]);

  const liveLtp = toNumber(liveTick?.ltp ?? liveTick?.last_price ?? ltpData?.ltp ?? chartStats.close);
  const prevClose = toNumber(liveTick?.close ?? chartStats.open ?? chartStats.close);
  const change = liveLtp != null && prevClose != null ? liveLtp - prevClose : null;
  const changePct = liveLtp != null && prevClose ? (change / prevClose) * 100 : null;

  if (!instrumentToken) {
    return (
      <div className="min-h-screen bg-[#f6f7f8] dark:bg-[#050806] flex items-center justify-center text-[#617589] dark:text-[#9cb7aa] text-sm">
        Select an instrument to view chart.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f7f8] dark:bg-[#050806] dark:text-[#e8f3ee] text-[#111418] flex flex-col">
      <header className="flex items-center bg-white dark:bg-[#0b120f] px-4 py-3 border-b border-gray-100 dark:border-[#22352d]">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex size-10 items-center justify-center text-[#111418] dark:text-[#e8f3ee] hover:bg-gray-100 dark:hover:bg-[#16231d] rounded-full transition-colors"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="ml-2 flex flex-col flex-1">
          <h2 className="text-[#111418] dark:text-[#e8f3ee] text-lg font-bold leading-tight tracking-tight">{symbol}</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium bg-gray-100 dark:bg-[#16231d] text-gray-600 dark:text-[#6f8b7f] px-1.5 py-0.5 rounded">
              {exchange}
            </span>
            <span className="text-xs text-gray-400 dark:text-[#6f8b7f]">{stock?.segment || 'EQ'}</span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          {isCustomerTradeAllowed ? (
            <>
              <button
                type="button"
                onClick={() => setOrderSheet({ open: true, side: 'BUY' })}
                className="h-9 px-4 rounded-full bg-[#137fec] text-white text-xs font-semibold shadow-sm hover:bg-blue-600 transition-colors"
              >
                BUY
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isOption) return;
                  setOrderSheet({ open: true, side: 'SELL' });
                }}
                disabled={isOption}
                className={`h-9 px-4 rounded-full text-xs font-semibold shadow-sm transition-colors ${
                  isOption
                    ? 'bg-gray-200 dark:bg-[#22352d] text-gray-400 dark:text-[#6f8b7f] cursor-not-allowed'
                    : 'bg-red-500 text-white hover:bg-red-600'
                }`}
              >
                {isOption && (
                  <span className="material-symbols-outlined text-[14px] mr-1 align-[-1px]">lock</span>
                )}
                SELL
              </button>
            </>
          ) : (
            <span className="text-[11px] text-amber-700 dark:text-amber-300 font-medium">{marketClosedReason}</span>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-32">
        <div className="px-4 pt-6 pb-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[#111418] dark:text-[#e8f3ee] text-[32px] font-bold leading-tight tracking-tight">
              {liveLtp != null ? `₹${Number(liveLtp).toFixed(2)}` : '—'}
            </h1>
            {changePct != null && (
              <span className={`flex items-center text-sm font-semibold ${changePct >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                <span className="material-symbols-outlined text-sm mr-0.5">
                  {changePct >= 0 ? 'arrow_drop_up' : 'arrow_drop_down'}
                </span>
                {change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}` : '--'} ({changePct >= 0 ? '+' : ''}
                {changePct.toFixed(2)}%)
              </span>
            )}
          </div>
          <p className="text-gray-400 dark:text-[#6f8b7f] text-xs mt-1">
            As of {IST_HEADER_TIME_FORMATTER.format(new Date())} IST
          </p>
        </div>

        <div className="px-4 py-2">
          <div className="flex h-9 items-center rounded-lg bg-[#f0f2f4] dark:bg-[#0b120f] p-1">
            {TIMEFRAMES.map((frame) => (
              <label
                key={frame.key}
                className={`flex-1 cursor-pointer h-full flex items-center justify-center rounded-md text-xs font-semibold transition-all ${
                  timeframe === frame.key ? 'bg-white dark:bg-[#111b17] shadow-sm text-[#137fec]' : 'text-gray-500 dark:text-[#6f8b7f]'
                }`}
              >
                <span>{frame.label}</span>
                <input
                  className="hidden"
                  type="radio"
                  name="timeframe"
                  checked={timeframe === frame.key}
                  onChange={() => setTimeframe(frame.key)}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="relative w-full h-[320px] bg-white dark:bg-[#111b17] mt-2 border-y border-gray-100 dark:border-[#22352d]">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-[#617589] dark:text-[#9cb7aa]">Loading chart…</div>
          ) : error ? (
            <div className="h-full flex items-center justify-center text-sm text-red-500">{error}</div>
          ) : candles.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-[#617589] dark:text-[#9cb7aa]">No chart data.</div>
          ) : (
            <TradingChart
              candles={candles}
              timeframe={timeframe}
              livePrice={liveLtp}
            />
          )}
        </div>

        <div className="p-4 grid grid-cols-2 gap-4 gap-y-6">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">Open</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{chartStats.open != null ? chartStats.open.toFixed(2) : '--'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">High</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{chartStats.high != null ? chartStats.high.toFixed(2) : '--'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">Low</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{chartStats.low != null ? chartStats.low.toFixed(2) : '--'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">Prev. Close</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{prevClose != null ? Number(prevClose).toFixed(2) : '--'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">Volume</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{chartStats.volume != null ? chartStats.volume.toLocaleString('en-IN') : '--'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 dark:text-[#6f8b7f]">Avg. Trade Price</span>
            <span className="text-sm font-semibold text-[#111418] dark:text-[#e8f3ee]">{chartStats.avg != null ? chartStats.avg.toFixed(2) : '--'}</span>
          </div>
        </div>
      </main>

      <OrderBottomSheet
        isOpen={orderSheet.open}
        side={orderSheet.side}
        stock={stock}
        ltpData={{ ltp: liveLtp, change: change ?? 0, changePercent: changePct ?? 0 }}
        ticksRef={ticksRef}
        tickUpdatedAtRef={tickUpdatedAtRef}
        onClose={() => setOrderSheet({ open: false, side: 'BUY' })}
        disableTrading={!isCustomerTradeAllowed}
        disableReason={marketClosedReason}
      />
    </div>
  );
};

export default ChartView;
