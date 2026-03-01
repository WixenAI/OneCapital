import Order from '../Model/Trading/OrdersModel.js';
import { closeOrderAndSettle } from '../services/closeOrderAndSettle.js';

// =========================================================
// 1. GLOBAL MEMORY (RAM) - THE WATCHLIST
// Key   = SecurityID/instrument_token (String)
// Value = Array of Order Objects
// =========================================================
export const activeTriggers = new Map();

/**
 * =========================================================
 * 2. INITIALIZATION (SERVER STARTUP)
 * Load all non-CLOSED orders with SL or Target into RAM.
 * =========================================================
 */
export const loadOpenOrders = async () => {
    try {
        console.log("🔄 [OrderManager] Loading active triggers...");

        const activeOrders = await Order.find({
            status: { $ne: 'CLOSED' },
            $or: [
                { stop_loss: { $exists: true, $ne: null, $gt: 0 } },
                { target: { $exists: true, $ne: null, $gt: 0 } }
            ]
        });

        activeTriggers.clear();

        activeOrders.forEach(order => {
            addToWatchlist(order);
        });

        console.log(`✅ [OrderManager] System Ready. Tracking ${activeOrders.length} active orders.`);
    } catch (error) {
        console.error("❌ [OrderManager] Failed to load orders:", error);
    }
};

/**
 * =========================================================
 * 3. ADD ORDER TO MEMORY
 * =========================================================
 */
export const addToWatchlist = (order) => {
    const orderStatus = order.status || order.order_status;
    if (orderStatus === 'CLOSED') return;

    const token = String(order.instrument_token || order.security_Id);
    const sl = Number(order.stop_loss) || 0;
    const target = Number(order.target) || 0;

    if (sl === 0 && target === 0) return;

    if (!activeTriggers.has(token)) {
        activeTriggers.set(token, []);
    }

    const triggerData = {
        orderId: String(order._id),
        side: order.side,
        sl: sl,
        target: target,
        status: orderStatus
    };

    activeTriggers.get(token).push(triggerData);
};

/**
 * =========================================================
 * 4. UPDATE ORDER IN MEMORY
 * =========================================================
 */
export const updateTriggerInWatchlist = (order) => {
    const token = String(order.instrument_token || order.security_Id);
    const orderIdStr = String(order._id);

    if (activeTriggers.has(token)) {
        const currentList = activeTriggers.get(token);
        const filteredList = currentList.filter(o => o.orderId !== orderIdStr);

        if (filteredList.length === 0) {
            activeTriggers.delete(token);
        } else {
            activeTriggers.set(token, filteredList);
        }
    }

    const orderStatus = order.status || order.order_status;
    if (orderStatus !== 'CLOSED') {
        addToWatchlist(order);
    }
};

/**
 * =========================================================
 * 5. EXECUTE EXIT (via closeOrderAndSettle)
 * When SL or Target is hit — close order AND settle funds.
 * =========================================================
 */
const executeExit = async (orderData, exitPrice, reason) => {
    const { orderId, token } = orderData;

    console.log(`⚡ [OrderManager] Trigger Hit! Order: ${orderId}, Reason: ${reason}, Price: ${exitPrice}`);

    try {
        // A. Remove from Memory IMMEDIATELY (prevent double execution)
        if (activeTriggers.has(token)) {
            const updatedList = activeTriggers.get(token).filter(o => o.orderId !== orderId);
            if (updatedList.length === 0) {
                activeTriggers.delete(token);
            } else {
                activeTriggers.set(token, updatedList);
            }
        }

        // B. Use unified close + settle service
        const exitReasonMap = {
            'STOPLOSS_HIT': 'stop_loss',
            'TARGET_HIT': 'target',
        };

        const result = await closeOrderAndSettle(orderId, {
            exitPrice,
            exitReason: exitReasonMap[reason] || reason,
            cameFrom: 'Open',
        });

        if (result.ok) {
            console.log(`✅ [OrderManager] Order ${orderId} closed & settled. P&L: ₹${result.pnl?.netPnl ?? 'N/A'}`);
        } else {
            console.error(`❌ [OrderManager] Failed to close ${orderId}: ${result.error}`);
        }
    } catch (error) {
        console.error(`❌ [OrderManager] Execution Error for Order ${orderId}:`, error);
    }
};

export const onMarketTick = async ({ token, ltp }) => {
    if (!activeTriggers.has(String(token))) return;

    const orders = activeTriggers.get(String(token));
    const currentLtp = Number(ltp);

    if (!currentLtp || currentLtp <= 0) return;

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];

        let hit = false;
        let hitReason = "";
        let hitPrice = 0;

        if (order.side === 'BUY') {
            if (order.sl > 0 && currentLtp <= order.sl) {
                hit = true;
                hitReason = "STOPLOSS_HIT";
                hitPrice = order.sl;
            } else if (order.target > 0 && currentLtp >= order.target) {
                hit = true;
                hitReason = "TARGET_HIT";
                hitPrice = order.target;
            }
        } else {
            if (order.sl > 0 && currentLtp >= order.sl) {
                hit = true;
                hitReason = "STOPLOSS_HIT";
                hitPrice = order.sl;
            } else if (order.target > 0 && currentLtp <= order.target) {
                hit = true;
                hitReason = "TARGET_HIT";
                hitPrice = order.target;
            }
        }

        if (hit) {
            await executeExit({ ...order, token: String(token) }, hitPrice, hitReason);
        }
    }
};
