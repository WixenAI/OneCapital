// sockets/io.js
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { config } from "../config.js";
import { getFeedInstance } from "../services/feedState.js";

let ioInstance = null;
let feedSubscriber = null;
let feedUnsubscriber = null;
let marketNamespace = null;

// Split mode: Redis client used by API instances to forward subscribe commands
// to wolf-worker over the 'kite:subscribe' pub/sub channel.
// This is subscribe-command-only — NOT used for tick data. Zero tick latency impact.
let subCommandPublisher = null;

const normalizeTokenList = (list = []) => {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const raw = item?.instrument_token ?? item?.instrumentToken ?? item?.token ?? item;
    const token = Number.parseInt(raw, 10);
    if (!Number.isFinite(token) || token <= 0) continue;
    const key = String(token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

const toInstrumentList = (tokens = []) => tokens.map((token) => ({ instrument_token: token }));
const roomForToken = (token) => `sec:${token}`;

// Token refcounts retained by backend systems (for example: SL/target trigger engine)
// token -> retainCount
const systemTokenRefs = new Map();

const publishSubscribe = (tokens = [], subscriptionType = 'full') => {
  if (!tokens.length) return;
  if (feedSubscriber) {
    // Single-instance or worker: call lmf.subscribe() directly.
    feedSubscriber(toInstrumentList(tokens), subscriptionType);
    return;
  }
  if (subCommandPublisher) {
    // Split mode API: forward to worker.
    subCommandPublisher.publish(
      'kite:subscribe',
      JSON.stringify({ list: toInstrumentList(tokens), subscriptionType })
    ).catch(err => console.error('[SubBridge] Publish failed:', err.message));
  }
};

const publishUnsubscribe = (tokens = []) => {
  if (!tokens.length) return;
  if (feedUnsubscriber) {
    // Single-instance or worker: call lmf.unsubscribe() directly.
    feedUnsubscriber(toInstrumentList(tokens));
    return;
  }
  if (subCommandPublisher) {
    // Split mode API: forward to worker.
    subCommandPublisher.publish(
      'kite:unsubscribe',
      JSON.stringify({ list: toInstrumentList(tokens) })
    ).catch(err => console.error('[SubBridge] Unsub publish failed:', err.message));
  }
};

const isRoomEmpty = (token) => {
  if (!marketNamespace) return true;
  const roomSockets = marketNamespace.adapter.rooms.get(roomForToken(token));
  return !roomSockets || roomSockets.size === 0;
};

const isSystemRetained = (token) => (systemTokenRefs.get(String(token)) || 0) > 0;

const collectUnsubscribableTokens = (tokens = []) => {
  const out = [];
  for (const token of tokens) {
    if (isSystemRetained(token)) continue;
    if (!isRoomEmpty(token)) continue;
    out.push(token);
  }
  return out;
};

const scheduleConditionalUnsubscribe = (tokens = []) => {
  if (!tokens.length) return;
  setImmediate(() => {
    const toUnsubscribe = collectUnsubscribableTokens(tokens);
    if (!toUnsubscribe.length) return;
    console.log(`[io.js] Unsubscribing ${toUnsubscribe.length} token(s) with no room/system retention`);
    publishUnsubscribe(toUnsubscribe);
  });
};

// Track token refcounts per socket:
// socketId -> Map<token, count>
const socketSubscriptions = new Map();

export function setFeedSubscriber(fn) { feedSubscriber = fn; }
export function setFeedUnsubscriber(fn) { feedUnsubscriber = fn; }
export function setSubCommandPublisher(client) { subCommandPublisher = client; }

export function retainSystemTokens(list, subscriptionType = 'quote') {
  const tokens = normalizeTokenList(list);
  if (tokens.length === 0) return;

  const toSubscribe = [];
  for (const token of tokens) {
    const prev = systemTokenRefs.get(token) || 0;
    const next = prev + 1;
    systemTokenRefs.set(token, next);
    if (prev === 0) toSubscribe.push(token);
  }

  if (toSubscribe.length > 0) {
    console.log(`[io.js] Retaining ${toSubscribe.length} system token(s)`);
    publishSubscribe(toSubscribe, subscriptionType);
  }
}

export function releaseSystemTokens(list) {
  const tokens = normalizeTokenList(list);
  if (tokens.length === 0) return;

  const maybeUnsubscribe = [];
  for (const token of tokens) {
    const prev = systemTokenRefs.get(token) || 0;
    if (prev <= 1) {
      if (prev > 0) {
        systemTokenRefs.delete(token);
        maybeUnsubscribe.push(token);
      }
    } else {
      systemTokenRefs.set(token, prev - 1);
    }
  }

  if (maybeUnsubscribe.length > 0) {
    console.log(`[io.js] Released ${maybeUnsubscribe.length} system token(s)`);
    scheduleConditionalUnsubscribe(maybeUnsubscribe);
  }
}

export function getSystemRetainedTokenCount() {
  return systemTokenRefs.size;
}

export function getIO() {
  if (!ioInstance) {
    throw new Error("Socket.IO has not been initialized!");
  }
  return ioInstance;
}

export async function createIO(server) {
  // --- CORS SETUP ---
  const isProduction = process.env.NODE_ENV === "production";
  const devOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
  ];
  const envOrigins = (config.origin || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowedOriginSet = new Set([
    ...(isProduction ? [] : devOrigins),
    ...envOrigins,
  ]);

  const io = new Server(server, {
    path: "/socket.io",
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOriginSet.has(origin)) return callback(null, true);
        return callback(new Error(`Socket CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"]
    },
    transports: ["websocket", "polling"],
  });
  // -------------------

  // --- Redis adapter for multi-instance room sync ---
  if (process.env.REDIS_URL) {
    try {
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log("[Socket.IO] ✅ Redis adapter attached");
    } catch (err) {
      console.warn("[Socket.IO] Redis adapter failed, using in-memory adapter:", err.message);
    }
  }

  ioInstance = io;

  const market = io.of("/market");
  marketNamespace = market;

  market.on("connection", (socket) => {
    console.log("📡 Market client connected:", socket.id);

    // Initialize subscription tracking for this socket
    socketSubscriptions.set(socket.id, new Map());

    socket.on("subscribe", (list, subscriptionType = 'full') => {
      const tokens = normalizeTokenList(list);
      if (tokens.length === 0) return;

      const tokenCounts = socketSubscriptions.get(socket.id);
      if (!tokenCounts) return;

      // Get feed instance to send cached data to new socket
      const feed = getFeedInstance();

      for (const token of tokens) {
        // Use instrument_token for room names (Kite format)
        const room = roomForToken(token);

        // Track this socket's subscription with refcount
        const prevCount = tokenCounts.get(token) || 0;
        const nextCount = prevCount + 1;
        tokenCounts.set(token, nextCount);

        // Join the room only on first subscription for this socket+token
        if (prevCount === 0) {
          socket.join(room);
        }

        // INSTANT DATA: Send cached data to this socket immediately
        // This ensures new/refreshed sockets get data without waiting for next tick
        if (feed?.last?.has(token)) {
          const cachedData = feed.last.get(token);
          if (cachedData && cachedData.ltp != null) {
            socket.emit("market_update", cachedData);
          }
        }
      }

      // Forward subscribe command AFTER room join to avoid missing first ticks
      // on split setup (worker may start emitting immediately).
      publishSubscribe(tokens, subscriptionType);
    });

    socket.on("unsubscribe", (list) => {
      const tokens = normalizeTokenList(list);
      if (tokens.length === 0) return;

      const tokenCounts = socketSubscriptions.get(socket.id);
      if (!tokenCounts) return;
      const maybeUnsubscribe = [];

      for (const token of tokens) {
        // Use instrument_token for room names (Kite format)
        const room = roomForToken(token);

        const prevCount = tokenCounts.get(token) || 0;
        if (prevCount <= 0) continue;

        const nextCount = prevCount - 1;
        if (nextCount > 0) {
          tokenCounts.set(token, nextCount);
        } else {
          tokenCounts.delete(token);

          // Leave the room only when this socket no longer needs token
          socket.leave(room);
          maybeUnsubscribe.push(token);
        }
      }
      scheduleConditionalUnsubscribe(maybeUnsubscribe);
    });

    socket.on("disconnect", (reason) => {
      console.log("❌ socket disconnected:", socket.id, reason);

      // Get tokens this socket was subscribed to
      const tokenCounts = socketSubscriptions.get(socket.id) || new Map();
      const tokens = Array.from(tokenCounts.keys());
      socketSubscriptions.delete(socket.id);

      if (tokens.length === 0) return;

      // Check each room - if empty after disconnect, unsubscribe unless token is system-retained.
      scheduleConditionalUnsubscribe(tokens);
    });
  });

  return { io, market };
}
