import { io } from 'socket.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';

const STALE_TICK_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

const normalizeList = (list = []) => {
  const seen = new Set();
  const out = [];
  list.forEach((item) => {
    const token =
      item?.instrument_token ??
      item?.instrumentToken ??
      item?.token ??
      item ??
      null;
    if (token == null) return;
    const key = String(token);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ instrument_token: token });
  });
  return out;
};

export const useMarketTicks = (url, opts = {}) => {
  const socketRef = useRef(null);
  const ticksRef = useRef(new Map());
  const tickUpdatedAtRef = useRef(new Map());
  const subscriptionBucketsRef = useRef(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const registerTokens = useCallback((normalized, subscriptionType) => {
    const type = String(subscriptionType || 'full');
    const buckets = subscriptionBucketsRef.current;
    if (!buckets.has(type)) {
      buckets.set(type, new Map());
    }
    const typeTokenMap = buckets.get(type);
    normalized.forEach((item) => {
      const key = String(item.instrument_token);
      const prevCount = typeTokenMap.get(key) || 0;
      typeTokenMap.set(key, prevCount + 1);
    });
  }, []);

  const unregisterTokens = useCallback((normalized, subscriptionType) => {
    const type = String(subscriptionType || 'full');
    const buckets = subscriptionBucketsRef.current;
    const typeTokenMap = buckets.get(type);
    if (!typeTokenMap) return;

    normalized.forEach((item) => {
      const key = String(item.instrument_token);
      const prevCount = typeTokenMap.get(key) || 0;
      if (prevCount <= 1) {
        typeTokenMap.delete(key);
      } else {
        typeTokenMap.set(key, prevCount - 1);
      }
    });

    if (typeTokenMap.size === 0) {
      buckets.delete(type);
    }
  }, []);

  const isTokenActive = useCallback((tokenKey) => {
    const key = String(tokenKey);
    const buckets = subscriptionBucketsRef.current;
    for (const typeTokenMap of buckets.values()) {
      if (typeTokenMap.has(key)) return true;
    }
    return false;
  }, []);

  const refreshSubscriptions = useCallback(() => {
    if (!socketRef.current?.connected) return;

    const buckets = subscriptionBucketsRef.current;
    for (const [type, typeTokenMap] of buckets.entries()) {
      if (!typeTokenMap || typeTokenMap.size === 0) continue;
      const payload = Array.from(typeTokenMap.keys()).map((token) => ({
        instrument_token: token,
      }));
      socketRef.current.emit('subscribe', payload, type);
    }
  }, []);

  const subscribe = useCallback((list, subscriptionType = 'full') => {
    const normalized = normalizeList(list);
    if (normalized.length === 0) return;

    registerTokens(normalized, subscriptionType);

    if (socketRef.current?.connected) {
      socketRef.current.emit('subscribe', normalized, subscriptionType);
    }
  }, [registerTokens]);

  const unsubscribe = useCallback((list, subscriptionType = 'full') => {
    const normalized = normalizeList(list);
    if (normalized.length === 0) return;

    unregisterTokens(normalized, subscriptionType);

    if (socketRef.current?.connected) {
      socketRef.current.emit('unsubscribe', normalized, subscriptionType);
    }
    normalized.forEach((item) => {
      const key = String(item.instrument_token);
      if (!isTokenActive(key)) {
        ticksRef.current.delete(key);
        tickUpdatedAtRef.current.delete(key);
      }
    });
  }, [isTokenActive, unregisterTokens]);

  useEffect(() => {
    if (!url) return undefined;

    const socket = io(url, {
      ...optsRef.current,
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 5000,
    });

    socketRef.current = socket;

    const onConnect = () => {
      setIsConnected(true);
      refreshSubscriptions();
    };

    const onDisconnect = () => {
      setIsConnected(false);
    };

    const onMarketUpdate = (update) => {
      if (!update || update.instrument_token == null) return;
      const key = String(update.instrument_token);
      const existing = ticksRef.current.get(key) || {};
      ticksRef.current.set(key, { ...existing, ...update });
      tickUpdatedAtRef.current.set(key, Date.now());
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('market_update', onMarketUpdate);
    socket.on('index_update', onMarketUpdate);
    socket.on('ticker_update', onMarketUpdate);
    socket.on('quote_update', onMarketUpdate);
    socket.on('oi_update', onMarketUpdate);
    socket.on('prev_close_update', onMarketUpdate);
    socket.on('market_status_update', onMarketUpdate);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('market_update', onMarketUpdate);
      socket.off('index_update', onMarketUpdate);
      socket.off('ticker_update', onMarketUpdate);
      socket.off('quote_update', onMarketUpdate);
      socket.off('oi_update', onMarketUpdate);
      socket.off('prev_close_update', onMarketUpdate);
      socket.off('market_status_update', onMarketUpdate);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [refreshSubscriptions, url]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      const now = Date.now();
      ticksRef.current.forEach((_value, key) => {
        if (isTokenActive(key)) return;
        const lastSeen = tickUpdatedAtRef.current.get(key) || 0;
        if (now - lastSeen >= STALE_TICK_MS) {
          ticksRef.current.delete(key);
          tickUpdatedAtRef.current.delete(key);
        }
      });
    }, PRUNE_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [isTokenActive]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (!socketRef.current?.connected) {
          socketRef.current?.connect();
        } else {
          refreshSubscriptions();
        }
      }
    };

    const handleFocus = () => {
      if (socketRef.current?.connected) {
        refreshSubscriptions();
      } else {
        socketRef.current?.connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refreshSubscriptions]);

  return {
    ticksRef,
    tickUpdatedAtRef,
    subscribe,
    unsubscribe,
    isConnected,
    refreshSubscriptions,
    socketRef,
  };
};
