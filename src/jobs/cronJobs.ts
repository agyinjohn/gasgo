import cron from 'node-cron';
import { Order } from '../models/Order';
import { Station } from '../models/Station';
import { sendSMS, sendPushNotification } from '../services/notificationService';

/**
 * Cancel orders stuck in 'pending' for more than 15 minutes (no rider accepted).
 * Excludes scheduled orders.
 */
export function startOrderCleanupJob(): void {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 15 * 60 * 1000);
      const stale = await Order.find({
        status: 'pending',
        isScheduled: { $ne: true },
        createdAt: { $lt: cutoff },
      });

      for (const order of stale) {
        order.status = 'cancelled';
        order.cancelledBy = 'system';
        order.cancellationReason = 'No rider available within 15 minutes';
        order.statusHistory.push({
          status: 'cancelled',
          triggeredBy: 'system',
          timestamp: new Date(),
          note: 'Auto-cancelled: no rider assigned',
        });
        await order.save();

        // Restore station stock for each line item
        const stationDoc = await Station.findById(order.stationId);
        if (stationDoc) {
          for (const item of order.cylinders) {
            const listing = stationDoc.cylinderListings.find((l) => l.size === item.size);
            if (listing) {
              listing.stockCount += item.quantity;
              listing.isAvailable = listing.stockCount > 0 && !listing.isPaused;
            }
          }
          await stationDoc.save();
        }

        // Trigger refund for captured payments
        if (order.paymentStatus === 'captured' && order.paystackReference) {
          try {
            const { initiateRefund } = await import('../services/paymentService');
            await initiateRefund(order.paystackReference);
            order.paymentStatus = 'refunded';
            await order.save();
          } catch (err) {
            console.error(`[Cron] Refund failed for order ${order._id}:`, err);
          }
        } else {
          order.paymentStatus = 'refunded';
          await order.save();
        }

        console.log(`[Cron] Auto-cancelled order ${order._id}`);
      }
    } catch (err) {
      console.error('[Cron] Order cleanup error:', err);
    }
  });

  console.log('⏰ Order cleanup cron started (every 5 min)');
}

/**
 * Check stations for low stock and send alerts — runs every hour.
 */
export function startLowStockAlertJob(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const stations = await Station.find({ status: 'active' });
      for (const station of stations) {
        for (const listing of station.cylinderListings) {
          if (listing.isAvailable && listing.stockCount <= listing.lowStockThreshold) {
            // Notify station owner via push / SMS (if fcmToken set)
            if (station.fcmToken) {
              await sendPushNotification(station.fcmToken, {
                title: '⚠️ Low Stock Alert',
                body: `Your ${listing.size}kg cylinder stock is low (${listing.stockCount} remaining)`,
                data: { screen: 'inventory', size: String(listing.size) },
              });
            }
            console.log(
              `[Cron] Low stock alert: Station ${station.name}, ${listing.size}kg = ${listing.stockCount}`
            );
          }
        }
      }
    } catch (err) {
      console.error('[Cron] Low stock alert error:', err);
    }
  });

  console.log('⏰ Low stock alert cron started (every hour)');
}

/**
 * Pick up scheduled orders that are due and dispatch them — runs every minute.
 */
export function startScheduledDispatchJob(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Find scheduled orders whose time has come (within the next 2 minutes window)
      const due = await Order.find({
        status: 'scheduled',
        scheduledFor: { $lte: new Date(now.getTime() + 2 * 60 * 1000) },
      });

      for (const order of due) {
        // Transition to pending and dispatch
        order.status = 'pending';
        order.statusHistory.push({
          status: 'pending',
          triggeredBy: 'system',
          timestamp: new Date(),
          note: 'Scheduled order dispatched',
        });
        await order.save();

        const { dispatchOrder } = await import('../services/dispatchService');
        dispatchOrder(order._id.toString()).catch(console.error);

        // Notify user
        const { User } = await import('../models/User');
        const user = await User.findById(order.userId).select('fcmToken phone');
        if (user?.fcmToken) {
          const sizes = order.cylinders.map((c: any) => `${c.quantity}x${c.size}kg`).join(', ');
          await sendPushNotification(user.fcmToken, {
            title: '🔥 Your scheduled order is on its way!',
            body: `We're finding a rider for your ${sizes} delivery.`,
            data: { orderId: order._id.toString(), screen: 'OrderTracking' },
          });
        }

        console.log(`[Cron] Dispatched scheduled order ${order._id}`);
      }
    } catch (err) {
      console.error('[Cron] Scheduled dispatch error:', err);
    }
  });

  console.log('⏰ Scheduled dispatch cron started (every minute)');
}

export function startAllJobs(): void {
  startOrderCleanupJob();
  startLowStockAlertJob();
  startScheduledDispatchJob();
}
