# Multi-User Backend Analysis and Scaling Plan
Date: 2026-03-01
Last Updated: 2026-03-01 (Phase A + B completed)
Project: `OneCapital`
Scope: Backend architecture, API routes, cron jobs, websocket flow, Redis/cache behavior, legacy usage (Kite vs Dhan/Upstox), and 1k+ user readiness.

---

## 1) Goal Definition
Primary goals:
- Run reliably for initial testing on Render with 50-100 active users.
- Scale safely toward 1k+ concurrent users without single-node bottlenecks.
- Support both local deployment and cloud deployment with predictable behavior.
- Remove unused legacy paths safely (without breaking current frontend flows).

Operational goals:
- Avoid duplicated cron execution and duplicated auto-squareoff behavior.
- Keep market websocket updates consistent across instances.
- Keep cache/session/auth behavior consistent across instances.
- Make system failure behavior explicit and controlled (not accidental).

---

## 2) Why This Matters Even If Backend "Runs Fine" Now
Current behavior is mostly fine in single-instance mode. The hidden issues appear when you move to multiple instances (`pm2 -i 8`, multi-replica cloud, or mixed realtime/API nodes):
- Each instance starts its own cron jobs.
- Each instance starts its own Kite websocket connection.
- Each instance keeps separate in-memory state.
- Some auth/cache/session logic is local-memory only, so behavior diverges per instance.

Result: system can "work in dev" but become inconsistent under scale.

---

## 3) Current Runtime Topology (Post Phase B)
`Backend/index.js` now has env-based role guards:
- Creates Express app and HTTP server (always).
- Creates Socket.IO namespace (always).
- Conditionally creates and connects `KiteWebSocket` (`ENABLE_WS_FEED`).
- Conditionally loads open-order triggers (`ENABLE_ORDER_TRIGGER_ENGINE`).
- Conditionally starts all cron jobs (`ENABLE_CRONS`):
  - Auto-login cron
  - Fund reconciliation cron
  - Squareoff scheduler cron
  - Master refresh cron

Default behavior (no env vars set): all roles enabled — identical to pre-Phase B single instance.

---

## 4) Route Surface: Current Mounts
Mounted in `Backend/app.js`:
- Legacy/mixed mounts:
  - `/api/auth`
  - `/api/watchlist`
  - `/api/orders`
  - `/api/funds`
  - `/api/registration`
  - `/api/debug` ← now protected with `authStrict` + role guard
  - `/api/kite`
  - `/api` market utility routes (`instrumentGetName`, option-chain helpers)
- Modular mounts:
  - `/api/admin`
  - `/api/broker`
  - `/api/customer`

---

## 5) Frontend Usage Map (What Is Actually Called)
Current frontend (`Frontend/src/api/*.js`) actively calls:
- `/customer/*` routes (main customer flows)
- `/broker/*` routes
- `/admin/*` routes
- `/auth/login` and `/auth/logout`
- `/kite/status`, `/kite/auto-login/trigger`, `/kite/login-url`

Legacy dependency still active from frontend:
- `/orders/updateOrder` is still called from:
  - `Frontend/src/api/customer.js`
  - `Frontend/src/api/broker.js`

Not found in current frontend code:
- Direct calls to `/watchlist/*` legacy route family
- Direct calls to `/funds/*` legacy route family
- Direct calls to `/registration/*` legacy route family
- Direct calls to `/debug/*`

Practical conclusion:
- Some legacy endpoints are still mounted but not used by current frontend.
- At least one legacy orders path is still actively used and cannot be removed yet.

---

## 6) Legacy and Provider Audit (Kite vs Dhan/Upstox)
### 6.1 Kite (actively used)
Active Kite path is clear:
- `services/KiteWebSocket.js`
- `services/kiteQuote.js`
- `services/kiteOptionChain.js`
- `services/kiteHistorical.js`
- `Routes/kiteAuthRoute.js`
- `services/AutoLoginService.js`

### 6.2 Dhan/Upstox leftovers (mixed state)
Observed Dhan/Upstox leftovers:
- `Backend/Routes/WatchlistQuoteRoute.js` uses Upstox but is not mounted in `app.js`.
- `Backend/Controllers/legacy/upstoxController.js` exists (legacy).
- `Backend/services/spotPriceCache.js` imports `./dhanOptionChain.js` which is missing.
- `Backend/api.js` is an Upstox instrument script (not runtime app entry).
- `Backend/scripts/legacy/*` contains older Dhan scripts.
- `cron/masterRefresh.js` Dhan-named loader path → FIXED (now points to `load_master_csv.js`).

Conclusion:
- Core runtime is Kite-based.
- Dhan/Upstox artifacts remain and should be treated as cleanup candidates (Phase D).

---

## 7) High-Impact Multi-Instance Risks
### 7.1 In-memory state that does not scale across instances
Local maps found in runtime:
- Order triggers: `Utils/OrderManager.js` -> `activeTriggers` ← contained by ENABLE_ORDER_TRIGGER_ENGINE (Phase B)
- Socket subscriptions: `sockets/io.js` -> `socketSubscriptions` ← requires Redis adapter (Phase C)
- Tick cache: `services/KiteWebSocket.js` -> `last` ← contained by ENABLE_WS_FEED (Phase B)
- Token blacklist: `Controllers/common/AuthController.js` -> `tokenBlack` ← requires Redis with TTL (Phase C)
- Search cache/analytics: `Routes/instruments.js` -> `searchCache`, `searchAnalytics` ← acceptable L1 cache
- Redis fallback cache: `services/redisCache.js` -> `memoryCache` ← resolved when real Redis connected (Phase C)

### 7.2 Websocket scaling gap
Current socket model:
- Uses namespace `/market` with rooms.
- No Socket.IO Redis adapter configured. ← Phase C
- Client uses `transports: ['websocket', 'polling']`. ← must change to websocket-only before scaling (pre-Phase C)

Render-specific finding (confirmed from docs):
- Render load balancer has NO sticky sessions — connections distributed randomly across instances.
- This makes Socket.IO Redis adapter mandatory before scaling Web Service beyond 1 instance.
- Polling transport must be disabled on frontend; Render returns HTTP 301 for plain ws:// which breaks clients.

### 7.3 Cron duplication
RESOLVED by Phase B env guards.
- `ENABLE_CRONS=false` on API instances prevents any cron from starting.
- Worker instance keeps `ENABLE_CRONS=true` — runs exactly once per schedule.

### 7.4 Duplicate external market feed connections
RESOLVED by Phase B env guards.
- `ENABLE_WS_FEED=false` on API instances prevents KiteWebSocket from being created.
- Worker instance keeps `ENABLE_WS_FEED=true` — one feed connection per environment.

---

## 8) Functional and Safety Findings

### 8.1 Route/middleware exposure risks — ALL RESOLVED ✅
- ~~`app.js` mounts `/api/debug` without protection.~~ → Fixed: `authStrict` added at mount point; `protect` + `requireAdminOrBroker` added to `run-squareoff` handler.
- ~~`Routes/fundRoute.js` has no `protect` middleware.~~ → Fixed: `protect` added to all 5 PUT endpoints.
- ~~`Routes/orderRoute.js` delete endpoints lack `protect`.~~ → Fixed: `protect` + `requireTrading` added to both delete routes.
- ~~`app.js` `authQuotes` checks token presence but does not verify JWT signature.~~ → Fixed: `jwt.verify()` now called in `authQuotes`.

### 8.2 Data/schema mismatch risks — PARTIALLY RESOLVED
- `Routes/UserWatchlistRoute.js` imports `Model/Trading/WatchListModel.js` but queries by `broker_id_str` (not in that schema). ← still open, deferred to Phase D
- Same file uses `mongoose.isValidObjectId(...)` without importing `mongoose`. ← still open, deferred to Phase D
- ~~`TradingController.getHoldings()` queries `{ userId: customerId }` while `HoldingModel` uses `customer_id*`.~~ → Fixed: changed to `{ customer_id: customerId }`.
- ~~`TradingController.getPositions()` queries `{ userId: customerId }` while `PositionsModel` uses `customer_id*`.~~ → Fixed: changed to `{ customer_id: customerId }`.
- Frontend includes `/auth/reset-password` API call, but matching backend route was not found. ← open, deferred

### 8.3 Mongoose duplicate indexes — ALL RESOLVED ✅
- ~~`Model/Auth/SessionModel.js`: `token` has `unique: true` plus `SessionSchema.index({ token: 1 })`~~ → Removed duplicate.
- ~~`Model/Trading/HoldingModel.js`: duplicate `customer_id_str` index~~ → Removed duplicate.
- ~~`Model/Trading/PositionsModel.js`: duplicate `broker_id_str` index~~ → Removed duplicate.
- ~~`Model/KYC/CustomerKYCModel.js`: duplicate `customer_id` index~~ → Removed duplicate.

### 8.4 Cron correctness issues — ALL RESOLVED ✅
- ~~`cron/autoLoginCron.js` double-timezone conversion~~ → Fixed: schedule changed to `'55 7 * * *'` (IST clock expression, matches `timezone: 'Asia/Kolkata'`).
- ~~`cron/masterRefresh.js` wrong script path and no timezone~~ → Fixed: path updated to `load_master_csv.js`, `timezone: 'Asia/Kolkata'` added.

### 8.5 Tooling issues — RESOLVED ✅
- ~~`Backend/package.json` `dev` script points to `server.js`~~ → Fixed: changed to `index.js`.

---

## 9) Legacy Classification for Safe Exclusion
Classification policy used:
- `Active`: referenced by mounted route and/or current frontend.
- `Mounted but not frontend-used`: still reachable externally; can be disabled after validation.
- `Unreachable/dead`: not mounted or broken dependency; strong cleanup candidate.

### 9.1 Active legacy pieces (do not remove yet)
- `/api/orders/updateOrder` path via `Routes/orderRoute.js` and legacy order controller (used by frontend customer/broker APIs).
- `/api/customer/postOrder` calls legacy order controller from modular customer routes.
- `/api/auth/login` and `/api/auth/logout` still used by admin frontend.

### 9.2 Mounted but currently not used by this frontend
- `/api/watchlist` -> `Routes/UserWatchlistRoute.js` (legacy shape, mismatch issues)
- `/api/funds` -> `Routes/fundRoute.js` (legacy fund controller — now protected)
- `/api/registration` -> `Routes/registrationRoute.js` (legacy registration flow)
- `/api/debug` -> debug utility routes (now protected)

### 9.3 Unmounted or dead candidates
- `Routes/WatchlistQuoteRoute.js` (Upstox quotes route, not mounted)
- `Routes/legacy/ListRoute.js` (not mounted)
- `services/spotPriceCache.js` (depends on missing `dhanOptionChain.js`, no active imports)
- `scripts/legacy/*` (script-only artifacts)
- `Controllers/index.js` appears unused as an aggregator

---

## 10) Redis and Cache Behavior in Current Design
`services/redisCache.js` behavior:
- Tries `REDIS_URL`, defaults to `redis://localhost:6379`.
- On connection failure, falls back to in-memory `Map`.
- Instruments search route uses Redis when available, memory cache otherwise.

Render Key-Value notes (from official docs):
- Render uses Valkey 8 (Redis 7.2.4 fork, fully drop-in compatible with all Redis clients).
- Two URLs: Internal (private network, ~0.5ms, no auth by default) and External (auth + IP allowlist required).
- Always use the Internal URL for `REDIS_URL` in backend env vars on Render.
- Free tier: zero persistence — data wiped on restart/redeploy. Not suitable for token blacklist or session state.
- Paid tier (Starter+): disk sync every 1 second. Use this for production.
- Recommended eviction policy for our use case: `noeviction` (token blacklist must never be silently dropped).

Phase C will:
- Point `REDIS_URL` at Render Key-Value internal URL.
- Add Socket.IO Redis adapter using separate pub/sub clients.
- Move `tokenBlack` in-memory Set to Redis with per-token TTL.

---

## 11) Full Scaling Checklist

### 11.1 Runtime role separation — COMPLETED ✅ (Phase B)
- `ENABLE_WS_FEED`, `ENABLE_CRONS`, `ENABLE_ORDER_TRIGGER_ENGINE` env guards added to `Backend/index.js`.
- `Backend/ecosystem.config.cjs` created with wolf-worker (fork, 1 instance) and wolf-api (cluster, N instances) profiles.
- Default: all flags enabled — single-instance behavior unchanged.

### 11.2 Websocket horizontal scaling — IN PROGRESS (Phase C)
- Socket.IO Redis adapter: not yet added. ← Phase C item 1
- Transport strategy: client must be changed to `transports: ['websocket']`. ← pre-Phase C item (frontend)
- Render confirmed: no sticky sessions — adapter is mandatory before scaling.

### 11.3 Market feed ownership — COMPLETED ✅ (Phase B)
- `ENABLE_WS_FEED=false` on API instances prevents duplicate KiteWebSocket creation.
- Worker instance owns feed exclusively.
- Health endpoint for feed status: deferred to Phase D/E.

### 11.4 Cron and scheduler safety — PARTIALLY COMPLETED
- Cron isolation: COMPLETED ✅ via `ENABLE_CRONS` guard (Phase B).
- Timezone and script path fixes: COMPLETED ✅ (Phase A).
- Distributed lock for critical crons: NOT YET ← Phase C item 2 (use Redis Redlock on squareoff + fund crons).
- Cron idempotency audit: deferred to Phase D.

### 11.5 State externalization — PARTIALLY COMPLETED
- Feed and trigger ownership enforced by env flags: COMPLETED ✅ (Phase B).
- Token blacklist Redis migration: NOT YET ← Phase C item 3.
- Trigger map / order watches: contained by single-worker ownership for now. Acceptable until Phase D.
- Instrument search cache: L1 in-memory is acceptable; Redis as L2 already wired, just needs live `REDIS_URL`.

### 11.6 API and auth hardening — COMPLETED ✅ (Phase A)
- Debug route protected with `authStrict` + `protect` + `requireAdminOrBroker`.
- Fund route PUT endpoints protected with `protect`.
- Order delete endpoints protected with `protect` + `requireTrading`.
- `authQuotes` now verifies JWT signature via `jwt.verify()`.
- Plaintext password compare path: still exists, deferred (migration risk — would lock out existing users without hash migration).

### 11.7 Data/model consistency fixes — PARTIALLY COMPLETED
- Duplicate Mongoose indexes: COMPLETED ✅ (Phase A).
- Holdings/positions query keys: COMPLETED ✅ (Phase A).
- Watchlist model-route mismatch: deferred to Phase D.
- `/auth/reset-password` route missing: deferred.

### 11.8 Legacy decommission plan — NOT STARTED (Phase D)
- Telemetry/hit counters not yet added.
- Dead files not yet removed.
- Mounted-but-unused routes still active.

### 11.9 Observability and operations — NOT STARTED (Phase D/E)
- Request-id propagation: not yet.
- Structured logs: not yet.
- Metrics tracking: not yet.

### 11.10 Load testing and release validation — NOT STARTED (Phase E)

---

## 12) Render Architecture — Confirmed Design (Post Research)

### Render service topology for production:
```
Render Key-Value (Valkey 8, Starter+ tier, same region as services)
  └── Internal URL → REDIS_URL env var in both services below

Render Web Service: "wolf-api"
  instances: 2–8 (manual or autoscale on CPU/memory)
  exec: cluster
  env: ENABLE_WS_FEED=false, ENABLE_CRONS=false, ENABLE_ORDER_TRIGGER_ENGINE=false
  env: REDIS_URL=<internal url>
  → Handles all HTTP API requests
  → Hosts Socket.IO server (synced via Redis adapter)

Render Background Worker: "wolf-worker"
  instances: 1 (always — never scale this)
  exec: fork
  env: ENABLE_WS_FEED=true, ENABLE_CRONS=true, ENABLE_ORDER_TRIGGER_ENGINE=true
  env: REDIS_URL=<internal url>
  note: no public port — Render Background Worker receives no incoming traffic
  → Owns Kite WebSocket feed
  → Runs all 4 cron jobs
  → Owns order trigger engine
  → Publishes ticks via Redis pub/sub → wolf-api instances → clients
```

### Render WebSocket behavior (confirmed from docs):
- Load balancer distributes WebSocket connections randomly — NO sticky sessions.
- WebSocket and HTTP share the same public port — no extra config needed.
- No fixed connection timeout — connections persist until instance replacement.
- SIGTERM gives 30-second graceful shutdown (extendable to 300s).
- Must use `wss://` — plain `ws://` gets a 301 redirect that breaks clients.

### Redis adapter latency impact:
- Kite → wolf-worker: ~15–40ms (internet)
- Redis pub/sub hop (same Render region): ~0.5–2ms
- Total added latency vs single-instance: ~1–4ms on a ~100ms journey
- Imperceptible in practice. Not an HFT system — retail trading UX threshold is ~80ms.

---

## 13) PM2 Ecosystem Config (Local Dev / Self-Hosted)
`Backend/ecosystem.config.cjs` is created and ready as reference for the Render topology.

IMPORTANT: Do not use the split config locally. The split is designed for Render where the
Background Worker receives no incoming traffic and has no port to bind. On Render there is
no port conflict. Locally, PM2 fork mode (wolf-worker) and cluster mode (wolf-api) both try
to bind the same port — this causes EADDRINUSE.

Local development rule:
- Always run as single instance: `pm2 start index.js --name wolf-backend`
- Or: `node index.js` / `npm run dev`
- All roles enabled by default. One port. No conflicts.

Render deployment rule:
- Web Service (wolf-api): cluster, N instances, roles disabled via env vars
- Background Worker (wolf-worker): fork, 1 instance, roles enabled via env vars
- No port conflict — Background Worker on Render never binds a public port

---

## 14) Concrete Execution Plan (Phased)

### ✅ Phase A — COMPLETED (Stabilize correctness and safety)
All items completed and committed:
- [x] Protected `/api/debug` with `authStrict` at mount + `protect` + `requireAdminOrBroker` on handler
- [x] Protected `/api/funds` PUT endpoints with `protect`
- [x] Protected `/api/orders` delete endpoints with `protect` + `requireTrading`
- [x] Fixed `authQuotes` to call `jwt.verify()` (was only checking token presence)
- [x] Fixed `getHoldings` and `getPositions` query from `{ userId }` to `{ customer_id }`
- [x] Removed 4 duplicate Mongoose index declarations
- [x] Fixed `autoLoginCron` schedule (`'25 2 * * *'` + IST timezone → `'55 7 * * *'` + IST timezone)
- [x] Fixed `masterRefresh` script path (`load_dhan_master_detailed.js` → `load_master_csv.js`) + added `timezone: 'Asia/Kolkata'`
- [x] Fixed `package.json` dev script (`server.js` → `index.js`)

### ✅ Phase B — COMPLETED (Role-based runtime separation)
All items completed and committed:
- [x] Added `ENABLE_WS_FEED` env guard to `Backend/index.js` — controls KiteWebSocket startup
- [x] Added `ENABLE_CRONS` env guard to `Backend/index.js` — controls all 4 cron jobs
- [x] Added `ENABLE_ORDER_TRIGGER_ENGINE` env guard to `Backend/index.js` — controls loadOpenOrders
- [x] Added process profile documentation comment in `index.js`
- [x] Created `Backend/ecosystem.config.cjs` with wolf-worker and wolf-api app definitions
- [x] Confirmed: default behavior (no env vars) identical to pre-Phase B — no regressions

### 🔲 Pre-Phase C Requirements (Must Do Before Starting Phase C)

Only two things needed — both are environment/infrastructure, no code changes:

#### PC-1: Install local Redis
```bash
sudo apt install redis-server
sudo systemctl start redis
sudo systemctl enable redis   # auto-start on reboot
```
Verify: `redis-cli ping` → should respond `PONG`

#### PC-2: Set REDIS_URL in Backend .env
```
REDIS_URL=redis://localhost:6379
```
The backend already reads this env var in `services/redisCache.js`.
When Render Key-Value is provisioned later, swap this value to the Render Internal URL — zero code changes required.

Note on transport lock (deferred):
- Frontend Socket.IO transport (`transports: ['websocket']`) is NOT needed now.
- It is only needed the moment the Web Service scales beyond 1 instance on Render.
- Polling breaks on multi-instance without sticky sessions; WebSocket transport does not.
- Add it as the very last step before scaling on Render — not a Phase C code requirement.

Note on Render Key-Value (deferred):
- Render's managed Redis (paid tier) is not needed until production Render deployment.
- Local Redis is sufficient for Phase C development and testing.
- When ready to deploy split architecture on Render: create Key-Value instance (Starter tier,
  same region, noeviction policy), copy Internal URL to REDIS_URL env var in both services.

### ✅ Phase C — COMPLETED (Distributed Infrastructure)
Completed and verified (server starts clean with all Phase C features active).

#### C-1: Socket.IO Redis adapter ✅
- Installed `@socket.io/redis-adapter`
- `Backend/sockets/io.js`: `createIO` made async; pub/sub Redis clients created and connected; adapter attached before namespace setup. Graceful fallback if Redis unavailable.
- `Backend/index.js`: `await createIO(server)` — awaits adapter before server starts.
- Startup log confirms: `[Socket.IO] ✅ Redis adapter attached`

#### C-2: Distributed cron lock ✅
- Created `Backend/services/cronLock.js`: `withLock(lockKey, ttlSeconds, fn)` using Redis SET NX EX. Falls back to direct execution if Redis unavailable. Lock is released in `finally` block.
- Applied to all 5 critical cron handlers:
  - `cron:squareoff:market-close-315` (TTL 240s) — 3:15 PM NSE/BSE intraday squareoff
  - `cron:squareoff:equity-expiry-320` (TTL 180s) — 3:20 PM equity expiry check
  - `cron:squareoff:mcx-close-2355` (TTL 240s) — 11:55 PM MCX squareoff
  - `cron:squareoff:midnight-0002` (TTL 480s) — 12:02 AM midnight cleanup
  - `cron:fund:midnight-reconcile-0005` (TTL 480s) — 12:05 AM margin reconciliation
- No extra npm package needed — uses Redis client from `services/cronLock.js` with SET NX EX.

#### C-3: Token blacklist → Redis with TTL ✅
- `Backend/services/redisCache.js`: added `blacklistToken(token, ttlSeconds)` and `checkBlacklist(token)` exports using `blacklist:<token>` key pattern.
- `Backend/Controllers/common/AuthController.js`: hybrid L1+L2 approach:
  - L1: in-memory Map (instant, no network hop, survives Redis blips)
  - L2: Redis (cross-instance — logout on any instance invalidates token on all instances)
  - `addToBlacklist`: writes L1 synchronously + L2 fire-and-forget async write
  - `isTokenBlacklisted`: checks L1 first (if found, skips Redis), then checks L2
- `Backend/Middleware/authMiddleware.js`: `await isBlacklisted(token)` — fixed sync call to properly await the async result.

### ✅ Phase D — COMPLETED (Legacy Removal — Session 1)
Confirmed via frontend audit: all three legacy route families replaced by new modular routes.

#### Removed from `app.js`:
- 3 import lines + 3 route mounts (`/api/watchlist`, `/api/funds`, `/api/registration`)

#### 11 files deleted:
- `Routes/UserWatchlistRoute.js` — replaced by `/api/customer/watchlist` (multi-watchlist)
- `Routes/fundRoute.js` — replaced by `/api/customer/funds` + `/api/broker/funds`
- `Routes/registrationRoute.js` — replaced by `/api/customer/register`
- `Routes/WatchlistQuoteRoute.js` — Upstox, never mounted
- `Controllers/legacy/fundController.js` — only served fundRoute
- `Controllers/legacy/RegistrationController.js` — only served registrationRoute
- `Controllers/legacy/upstoxController.js` — only served WatchlistQuoteRoute
- `Controllers/legacy/quoteController.js` — orphaned 501 stub
- `Controllers/legacy/index.js` — barrel file, nothing imported from it
- `services/spotPriceCache.js` — Dhan/missing dependency, not used
- `scripts/legacy/force-renew-token.js` — Dhan token script, dead

#### Still live (do NOT remove):
- `Routes/orderRoute.js` + `Controllers/legacy/orderController.js` — `/orders/updateOrder` still called by frontend
- `Controllers/legacy/SuperBrocker.js` + `CustomerController.js` — used by `/api/auth` login/logout

#### Phase D Session 2 (deferred — no deadline):
- `/auth/reset-password` backend route missing (frontend calls it, no backend exists) — proper feature, separate scope
- Remove `/api/orders` legacy route after frontend fully migrates off `/orders/updateOrder`

#### Multi-instance bug fixed (discovered during Phase D testing):
**Root cause:** In split mode, `feedSubscriber` is null on wolf-api instances — subscribe commands from
clients never reached wolf-worker → Kite never subscribed → zero ticks despite Redis adapter working.

**Fix — Subscription command bridge (zero tick latency impact):**
- `Backend/index.js`: wolf-worker opens dedicated Redis client, listens on `kite:subscribe` pub/sub channel.
  When message received: calls `lmf.subscribe(list, subscriptionType)`.
  Wolf-api opens dedicated Redis client, calls `setSubCommandPublisher()` to pass it to io.js.
- `Backend/sockets/io.js`: added `subCommandPublisher` + `setSubCommandPublisher` export.
  In "subscribe" handler: if `feedSubscriber` is set → call directly (single-instance / worker).
  If `feedSubscriber` is null but `subCommandPublisher` is set → publish to `kite:subscribe` (API instance).
- Subscribe commands are one-time per watchlist open (not per tick). Zero latency added to tick path.
- Tick path unchanged: Kite → wolf-worker RAM → Socket.IO Redis adapter → wolf-api → client.
- **Validated:** data flowing correctly in split mode (pm2 ecosystem.config.cjs). Live market latency
  test pending (market was closed at time of validation).

### 🔲 Phase E — Performance Certification (Next after live market validation)
- Stage 1 (50-100 users): mixed read/write API + websocket + order lifecycle
- Stage 2 (300-500 users): failover simulation, cron overlap verification
- Stage 3 (1000+ users): multi-instance balancing, websocket consistency, no duplicate squareoff
- Gate on: p95 tick-to-client latency, zero duplicate squareoffs, zero fund reconciliation drift

---

## 15) Final Summary
Phases A through D are complete. The system is now:
- **Secure**: all legacy mutation routes protected, authQuotes verifies JWT, debug route admin-only
- **Correct**: cron timezones fixed, query fields fixed, duplicate indexes removed
- **Role-separated**: ENABLE_WS_FEED / ENABLE_CRONS / ENABLE_ORDER_TRIGGER_ENGINE flags in index.js
- **Distributed**: Socket.IO Redis adapter, distributed cron locks, Redis token blacklist, subscription command bridge
- **Clean**: 11 dead legacy files removed, 3 unused route families unmounted

**Current local PM2 setup:**
```bash
# Single instance (default dev):
pm2 start index.js --name wolf-backend

# Split mode (production simulation, requires Redis):
pm2 start ecosystem.config.cjs
# wolf-worker: port 8082, fork, 1 instance — feed + crons + triggers
# wolf-api: port 8080, cluster, N instances — HTTP + Socket.IO
```

**Remaining before Render production deployment:**
- [ ] Live market validation: confirm tick latency acceptable in split mode
- [ ] Frontend Socket.IO transport locked to `['websocket']` (required before scaling wolf-api > 1 instance on Render)
- [ ] Render Key-Value provisioned (Starter tier, same region, noeviction) when budget allows
- [ ] Render Background Worker service created with worker env vars
- [ ] Render Web Service scaled after Redis adapter and worker service are live
