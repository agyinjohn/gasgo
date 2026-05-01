import mongoose from 'mongoose';
import { Order } from '../models/Order';
import { Rider } from '../models/Rider';
import { CONSTANTS } from '../config/constants';
import { getNearbyRiders } from './geoService';
import { emitOrderToRider, emitOrderToStation } from './realtimeService';
import { sendPushNotification } from './notificationService';

/**
 * Attempt to dispatch an order to the nearest available rider.
 * Tries up to MAX_DISPATCH_ATTEMPTS riders before escalating to admin.
 */
export async function dispatchOrder(orderId: string): Promise<void> {
  const order = await Order.findById(orderId).populate('stationId', 'lat lng name _id');
  if (!order || order.status !== 'pending') return;

  const station = order.stationId as unknown as { _id: mongoose.Types.ObjectId; lat: number; lng: number; name: string };

  if (order.dispatchAttempts.length >= CONSTANTS.MAX_DISPATCH_ATTEMPTS) {
    await escalateToAdmin(orderId);
    return;
  }

  const nearbyRiders = await getNearbyRiders(station.lat, station.lng, CONSTANTS.DISPATCH_RADIUS_KM);

  // Filter out riders already attempted
  const attemptedIds = new Set(order.dispatchAttempts.map((a) => a.riderId.toString()));
  const eligibleRiders = nearbyRiders.filter((r) => !attemptedIds.has(r.riderId));

  if (eligibleRiders.length === 0) {
    await escalateToAdmin(orderId);
    return;
  }

  // Find the first truly available rider (geo query may be slightly stale)
  let rider = null;
  for (const candidate of eligibleRiders) {
    const r = await Rider.findOne({ _id: candidate.riderId, status: 'available', kycStatus: 'approved' });
    if (r) { rider = r; break; }
  }

  if (!rider) {
    await escalateToAdmin(orderId);
    return;
  }

  // Log dispatch attempt with 'timeout' as default — updated below if rider responds
  order.dispatchAttempts.push({
    riderId: rider._id,
    sentAt: new Date(),
    outcome: 'timeout',
  });
  await order.save();

  const attemptIndex = order.dispatchAttempts.length - 1;

  // Notify rider via socket + push
  const orderSummary = {
    orderId: order._id.toString(),
    cylinders: order.cylinders,
    orderType: order.orderType,
    deliveryAddress: order.deliveryAddress,
    earning: +(order.stationPayout * 0.15).toFixed(2),
    timeoutSeconds: CONSTANTS.ORDER_ACCEPT_TIMEOUT_MS / 1000,
  };

  emitOrderToRider(rider._id.toString(), orderSummary);

  if (rider.fcmToken) {
    const sizes = order.cylinders.map((c) => `${c.quantity}×${c.size}kg`).join(', ');
    await sendPushNotification(rider.fcmToken, {
      title: 'New Delivery Order',
      body: `${sizes} — ${order.orderType}. GH₵${orderSummary.earning}. Tap to accept.`,
      data: { orderId: order._id.toString(), screen: 'OrderAccept' },
    });
  }

  // Notify station of incoming order
  emitOrderToStation(station._id.toString(), {
    orderId: order._id.toString(),
    cylinders: order.cylinders,
    orderType: order.orderType,
    deliveryAddress: order.deliveryAddress,
    riderName: rider.name,
  });

  // Timeout — if rider hasn't accepted, try next
  setTimeout(async () => {
    try {
      const freshOrder = await Order.findById(orderId);
      if (!freshOrder || freshOrder.status !== 'pending') return;

      // Mark this attempt as timed out (it was already set to 'timeout', just ensure it's saved)
      const attempt = freshOrder.dispatchAttempts[attemptIndex];
      if (attempt && attempt.riderId.toString() === rider!._id.toString()) {
        attempt.outcome = 'timeout';
        await freshOrder.save();
      }

      // Try next rider
      await dispatchOrder(orderId);
    } catch (err) {
      console.error('[Dispatch] Timeout handler error:', err);
    }
  }, CONSTANTS.ORDER_ACCEPT_TIMEOUT_MS);
}

/**
 * Called by the rider's accept action (PATCH /orders/:id/status → accepted).
 * Updates the dispatch attempt outcome to 'accepted'.
 */
export async function markDispatchAccepted(orderId: string, riderId: string): Promise<void> {
  await Order.updateOne(
    { _id: orderId, 'dispatchAttempts.riderId': new mongoose.Types.ObjectId(riderId) },
    { $set: { 'dispatchAttempts.$.outcome': 'accepted' } }
  );
}

/**
 * Called when a rider explicitly declines an order.
 * Updates outcome and immediately tries the next rider.
 */
export async function markDispatchDeclined(orderId: string, riderId: string): Promise<void> {
  await Order.updateOne(
    { _id: orderId, 'dispatchAttempts.riderId': new mongoose.Types.ObjectId(riderId) },
    { $set: { 'dispatchAttempts.$.outcome': 'declined' } }
  );
  await dispatchOrder(orderId);
}

async function escalateToAdmin(orderId: string): Promise<void> {
  await Order.findByIdAndUpdate(orderId, {
    $push: {
      statusHistory: {
        status: 'pending',
        triggeredBy: 'system',
        timestamp: new Date(),
        note: 'Escalated to admin — no riders available',
      },
    },
  });
  console.warn(`[Dispatch] Order ${orderId} escalated to admin — no riders available`);
  // TODO: emit to admin socket room + send admin push/email alert
}
