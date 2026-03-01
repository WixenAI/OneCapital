import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import { useMarketData } from '../context/SocketContext';

const getTickLtp = (tick) => {
  if (!tick) return null;
  return (
    tick.ltp ??
    tick.last_price ??
    tick.lastPrice ??
    tick.close ??
    null
  );
};

const getTickOi = (tick) => {
  if (!tick) return null;
  return tick.oi ?? tick.open_interest ?? tick.openInterest ?? null;
};

const getTickVolume = (tick) => {
  if (!tick) return null;
  return tick.volume ?? tick.volume_traded ?? tick.volumeTraded ?? null;
};

export const useOptionChain = ({
  name,
  segment,
  expiry,
  tradingsymbol,
  instrumentToken,
  subscriptionType = 'quote',
}) => {
  const [chainData, setChainData] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [spotInstrumentInfo, setSpotInstrumentInfo] = useState(null);
  const [expiries, setExpiries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({ underlying: null, segment: null, expiry: null });

  const { ticksRef, subscribe, unsubscribe } = useMarketData();

  const [liveByToken, setLiveByToken] = useState({});

  // ticksReady: false until first live tick batch arrives for this chain.
  // Resets to false on every new fetch so the table never shows stale 0 prices.
  // Falls back to true after 5 seconds in case market is closed / no ticks come.
  const [ticksReady, setTicksReady] = useState(false);
  const ticksReadyRef = useRef(false);
  const ticksReadyTimeoutRef = useRef(null);

  const tokenMapRef = useRef(new Map());
  const subscribedRef = useRef([]);
  const lastFetchKeyRef = useRef(null);
  const spotTokenRef = useRef(null);
  const prevLiveByTokenRef = useRef({});

  const unsubscribeFromOptions = useCallback(() => {
    if (!subscribedRef.current.length) return;
    unsubscribe(subscribedRef.current, subscriptionType);
    subscribedRef.current = [];
    tokenMapRef.current.clear();
    spotTokenRef.current = null;
  }, [subscriptionType, unsubscribe]);

  const subscribeToOptions = useCallback((chainArray, spotInfo) => {
    const list = [];
    const tokenMap = new Map();

    chainArray.forEach((row, index) => {
      if (row.call?.instrument_token) {
        const token = String(row.call.instrument_token);
        list.push({ instrument_token: token });
        tokenMap.set(token, { index, type: 'call' });
      }
      if (row.put?.instrument_token) {
        const token = String(row.put.instrument_token);
        list.push({ instrument_token: token });
        tokenMap.set(token, { index, type: 'put' });
      }
    });

    if (spotInfo?.token) {
      const token = String(spotInfo.token);
      list.push({ instrument_token: token });
      spotTokenRef.current = token;
    } else {
      spotTokenRef.current = null;
    }

    if (!list.length) return;

    tokenMapRef.current = tokenMap;
    subscribedRef.current = list;
    subscribe(list, subscriptionType);
  }, [subscribe, subscriptionType]);

  const fetchOptionChain = useCallback(async () => {
    if (!name && !tradingsymbol && !instrumentToken) return;
    const params = {};
    if (name) params.name = name;
    if (segment) params.segment = segment;
    if (expiry) params.expiry = expiry;
    if (tradingsymbol) params.tradingsymbol = tradingsymbol;
    if (instrumentToken) params.instrument_token = instrumentToken;

    const fetchKey = `${name}|${tradingsymbol || ''}|${segment || 'auto'}|${expiry || 'nearest'}`;
    if (lastFetchKeyRef.current === fetchKey) return;

    setLoading(true);
    setError(null);

    // Reset ticks-ready on every new fetch — never show 0-price table
    setTicksReady(false);
    ticksReadyRef.current = false;
    if (ticksReadyTimeoutRef.current) clearTimeout(ticksReadyTimeoutRef.current);

    try {
      const response = await api.get('/option-chain', { params });
      const payload = response?.data?.data;
      const chain = payload?.chain || [];

      setChainData(chain);
      // Reset live data map when chain reloads so stale tokens don't linger.
      prevLiveByTokenRef.current = {};
      setLiveByToken({});
      setSpotInstrumentInfo(payload?.spotInstrumentInfo || null);
      setMeta({
        underlying: payload?.underlying || name,
        segment: payload?.segment || segment || null,
        expiry: payload?.expiry || expiry || null,
      });
      setSpotPrice(null);

      lastFetchKeyRef.current = fetchKey;

      unsubscribeFromOptions();
      if (chain.length) {
        subscribeToOptions(chain, payload?.spotInstrumentInfo);
        // 5-second fallback: if no ticks arrive (market closed, weekend),
        // show the table anyway rather than blocking the user forever.
        ticksReadyTimeoutRef.current = setTimeout(() => {
          if (!ticksReadyRef.current) {
            ticksReadyRef.current = true;
            setTicksReady(true);
          }
        }, 5000);
      } else {
        // Empty chain — nothing to wait for
        ticksReadyRef.current = true;
        setTicksReady(true);
      }
    } catch (err) {
      setError(err?.response?.data?.details || err?.message || 'Failed to fetch option chain');
      setChainData([]);
      // On error, unblock so error message shows
      ticksReadyRef.current = true;
      setTicksReady(true);
    } finally {
      setLoading(false);
    }
  }, [name, segment, expiry, tradingsymbol, instrumentToken, subscribeToOptions, unsubscribeFromOptions]);

  const fetchExpiries = useCallback(async () => {
    if (!name && !tradingsymbol && !instrumentToken) return;
    try {
      const params = {};
      if (name) params.name = name;
      if (segment) params.segment = segment;
      if (tradingsymbol) params.tradingsymbol = tradingsymbol;
      if (instrumentToken) params.instrument_token = instrumentToken;
      const response = await api.get('/option-chain/expiries', { params });
      const data = response?.data?.data;
      setExpiries(data?.expiries || []);
    } catch {
      setExpiries([]);
    }
  }, [name, segment, tradingsymbol, instrumentToken]);

  useEffect(() => {
    if (!name && !tradingsymbol && !instrumentToken) return undefined;
    fetchOptionChain();
    fetchExpiries();
    return () => {
      unsubscribeFromOptions();
      if (ticksReadyTimeoutRef.current) clearTimeout(ticksReadyTimeoutRef.current);
    };
  }, [name, segment, expiry, tradingsymbol, instrumentToken, fetchOptionChain, fetchExpiries, unsubscribeFromOptions]);

  // Keep liveByToken in sync with ticks via RAF loop.
  // This replaces the chain-array-mutation approach: we update a flat token→values
  // map instead of cloning the whole chain array on every tick cycle.
  // chainData remains stable (no reference changes), so all memos derived from it
  // stay cached. The component merges live values at render time.
  useEffect(() => {
    let animationFrameId;
    let lastUpdate = 0;
    const THROTTLE_MS = 60;

    const updateLoop = (timestamp) => {
      if (document.visibilityState === 'hidden') {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      if (timestamp - lastUpdate < THROTTLE_MS) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      if (!tokenMapRef.current.size) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      const ticks = ticksRef.current;
      const prev = prevLiveByTokenRef.current;
      let hasChanges = false;
      const next = { ...prev };

      tokenMapRef.current.forEach((_, token) => {
        const tick = ticks.get(token);
        if (!tick) return;

        const nextLtp = getTickLtp(tick);
        const nextOi = getTickOi(tick);
        const nextVolume = getTickVolume(tick);

        if (nextLtp == null && nextOi == null && nextVolume == null) return;

        const existing = prev[token];
        if (
          existing?.ltp !== nextLtp ||
          existing?.oi !== nextOi ||
          existing?.volume !== nextVolume
        ) {
          next[token] = { ltp: nextLtp, oi: nextOi, volume: nextVolume };
          hasChanges = true;
        }
      });

      if (hasChanges) {
        prevLiveByTokenRef.current = next;
        setLiveByToken(next);
        lastUpdate = timestamp;

        // First tick batch arrived — mark live prices as ready
        if (!ticksReadyRef.current) {
          ticksReadyRef.current = true;
          if (ticksReadyTimeoutRef.current) clearTimeout(ticksReadyTimeoutRef.current);
          setTicksReady(true);
        }
      }

      animationFrameId = requestAnimationFrame(updateLoop);
    };

    animationFrameId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [ticksRef]);

  useEffect(() => {
    const token = spotTokenRef.current;
    if (!token) return undefined;

    let animationFrameId;
    let lastUpdate = 0;
    const THROTTLE_MS = 60;

    const updateLoop = (timestamp) => {
      if (timestamp - lastUpdate < THROTTLE_MS) {
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      const tick = ticksRef.current.get(token);
      const nextLtp = getTickLtp(tick);
      if (nextLtp != null) {
        setSpotPrice((prev) => (prev === nextLtp ? prev : nextLtp));
        lastUpdate = timestamp;
      }

      animationFrameId = requestAnimationFrame(updateLoop);
    };

    animationFrameId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [ticksRef, spotInstrumentInfo]);

  return {
    chainData,
    liveByToken,
    spotPrice,
    spotInstrumentInfo,
    expiries,
    loading,
    ticksReady,
    error,
    refetch: fetchOptionChain,
    meta,
  };
};

