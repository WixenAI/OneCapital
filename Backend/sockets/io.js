// sockets/io.js
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { config } from "../config.js";
import { getFeedInstance } from "../services/feedState.js";

let ioInstance = null;
let feedSubscriber = null;
let feedUnsubscriber = null;

// Split mode: Redis client used by API instances to forward subscribe commands
// to wolf-worker over the 'kite:subscribe' pub/sub channel.
// This is subscribe-command-only — NOT used for tick data. Zero tick latency impact.
let subCommandPublisher = null;

// Track which tokens each socket has subscribed to
const socketSubscriptions = new Map(); // socketId -> Set<token>

export function setFeedSubscriber(fn) { feedSubscriber = fn; }
export function setFeedUnsubscriber(fn) { feedUnsubscriber = fn; }
export function setSubCommandPublisher(client) { subCommandPublisher = client; }

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

  market.on("connection", (socket) => {
    console.log("📡 Market client connected:", socket.id);

    // Initialize subscription tracking for this socket
    socketSubscriptions.set(socket.id, new Set());

    socket.on("subscribe", (list, subscriptionType = 'full') => {
      if (feedSubscriber) {
        // Single-instance or worker: call lmf.subscribe() directly
        feedSubscriber(list, subscriptionType);
      } else if (subCommandPublisher) {
        // Split mode (API instance): forward command to wolf-worker via Redis pub/sub.
        // Wolf-worker receives it on 'kite:subscribe' channel and calls lmf.subscribe().
        // This fires once per subscribe event — NOT per tick. Zero latency impact on ticks.
        subCommandPublisher.publish(
          'kite:subscribe',
          JSON.stringify({ list, subscriptionType })
        ).catch(err => console.error('[SubBridge] Publish failed:', err.message));
      }

      // Get feed instance to send cached data to new socket
      const feed = getFeedInstance();

      for (const it of list || []) {
        // Use instrument_token for room names (Kite format)
        const token = String(it.instrument_token);
        const room = `sec:${token}`;

        // Track this socket's subscription
        socketSubscriptions.get(socket.id)?.add(token);

        // Join the room
        socket.join(room);

        // INSTANT DATA: Send cached data to this socket immediately
        // This ensures new/refreshed sockets get data without waiting for next tick
        if (feed?.last?.has(token)) {
          const cachedData = feed.last.get(token);
          if (cachedData && cachedData.ltp != null) {
            socket.emit("market_update", cachedData);
          }
        }
      }
    });

    socket.on("unsubscribe", (list) => {
      for (const it of list || []) {
        // Use instrument_token for room names (Kite format)
        const token = String(it.instrument_token);
        const room = `sec:${token}`;

        // Remove from socket's subscription tracking
        socketSubscriptions.get(socket.id)?.delete(token);

        // Leave the room
        socket.leave(room);

        // Check if room is now empty - if so, unsubscribe from Kite
        // Use setImmediate to ensure socket.leave() has completed
        setImmediate(() => {
          const roomSockets = market.adapter.rooms.get(room);
          if (!roomSockets || roomSockets.size === 0) {
            console.log(`[io.js] Room ${room} is empty, unsubscribing from Kite`);
            if (feedUnsubscriber) {
              feedUnsubscriber([{ instrument_token: token }]);
            }
          }
        });
      }
    });

    socket.on("disconnect", (reason) => {
      console.log("❌ socket disconnected:", socket.id, reason);

      // Get tokens this socket was subscribed to
      const tokens = socketSubscriptions.get(socket.id) || new Set();
      socketSubscriptions.delete(socket.id);

      if (tokens.size === 0) return;

      // Check each room - if empty after this disconnect, unsubscribe from Kite
      // Use setImmediate to ensure socket has fully left all rooms
      setImmediate(() => {
        for (const token of tokens) {
          const room = `sec:${token}`;
          const roomSockets = market.adapter.rooms.get(room);

          if (!roomSockets || roomSockets.size === 0) {
            console.log(`[io.js] Room ${room} is empty after disconnect, unsubscribing from Kite`);
            if (feedUnsubscriber) {
              feedUnsubscriber([{ instrument_token: token }]);
            }
          }
        }
      });
    });
  });

  return { io, market };
}
