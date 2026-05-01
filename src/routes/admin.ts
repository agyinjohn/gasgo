import { Router, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Station } from '../models/Station';
import { Rider } from '../models/Rider';
import { Order } from '../models/Order';
import { User } from '../models/User';
import { PricingConfig } from '../models/PricingConfig';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requireRole } from '../middleware/requireRole';
import { initiateRefund } from '../services/paymentService';
import { emitOrderStatus } from '../services/realtimeService';
import { sendPushNotification, sendSMS, SMS_TEMPLATES } from '../services/notificationService';
import { encodeGeohash } from '../services/geoService';

const router = Router();
router.use(authenticate, requireRole('admin'));

function ve(req: any, res: Response): boolean {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ success: false, errors: e.array() }); return true; }
  return false;
}

// ─── Platform Metrics ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/metrics:
 *   get:
 *     tags: [Admin]
 *     summary: Get platform-wide metrics
 *     responses:
 *       200:
 *         description: Orders, stations, riders, financials, users stats
 */
router.get('/metrics', async (_req: AuthRequest, res: Response) => {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalOrders, todayOrders,
    activeStations, pendingStations,
    activeRiders, pendingRiders,
    gmvResult, avgOrderValue,
    newUsersToday,
  ] = await Promise.all([
    Order.countDocuments({ status: 'delivered' }),
    Order.countDocuments({ status: 'delivered', createdAt: { $gte: startOfDay } }),
    Station.countDocuments({ status: 'active' }),
    Station.countDocuments({ status: 'pending' }),
    Rider.countDocuments({ status: { $in: ['available', 'busy'] } }),
    Rider.countDocuments({ kycStatus: 'pending' }),
    Order.aggregate([
      { $match: { status: 'delivered', createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, gmv: { $sum: '$totalAmount' }, commission: { $sum: '$commissionAmount' } } },
    ]),
    Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, avg: { $avg: '$totalAmount' } } },
    ]),
    User.countDocuments({ createdAt: { $gte: startOfDay } }),
  ]);

  res.json({
    success: true,
    metrics: {
      orders: { total: totalOrders, today: todayOrders },
      stations: { active: activeStations, pending: pendingStations },
      riders: { active: activeRiders, pendingKYC: pendingRiders },
      financials: {
        monthGMV: gmvResult[0]?.gmv || 0,
        monthCommission: gmvResult[0]?.commission || 0,
        avgOrderValue: avgOrderValue[0]?.avg || 0,
      },
      users: { newToday: newUsersToday },
    },
  });
});

// ─── Station Management ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/stations:
 *   get:
 *     tags: [Admin]
 *     summary: List all stations with optional status filter
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, active, suspended, banned] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated stations
 */
router.get('/stations', async (req: AuthRequest, res: Response) => {
  const { status, page = '1', limit = '20' } = req.query as Record<string, string>;
  const filter = status ? { status } : {};
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [stations, total] = await Promise.all([
    Station.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Station.countDocuments(filter),
  ]);

  res.json({ success: true, stations, pagination: { page: parseInt(page), total } });
});

/**
 * @swagger
 * /api/v1/admin/stations/{id}/status:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve, suspend or ban a station
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [active, suspended, banned] }
 *     responses:
 *       200:
 *         description: Updated station
 */
router.patch(
  '/stations/:id/status',
  [body('status').isIn(['active', 'suspended', 'banned'])],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const station = await Station.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });
    res.json({ success: true, station });
  }
);

/**
 * @swagger
 * /api/v1/admin/stations/{id}/commission:
 *   patch:
 *     tags: [Admin]
 *     summary: Set platform commission % for a station
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [commissionPct]
 *             properties:
 *               commissionPct: { type: number, minimum: 0, maximum: 100 }
 *     responses:
 *       200:
 *         description: Updated station
 */
router.patch(
  '/stations/:id/commission',
  [body('commissionPct').isFloat({ min: 0, max: 100 })],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const station = await Station.findByIdAndUpdate(
      req.params.id,
      { commissionPct: req.body.commissionPct },
      { new: true }
    );
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });
    res.json({ success: true, station });
  }
);

/**
 * @swagger
 * /api/v1/admin/stations/{id}/location:
 *   patch:
 *     tags: [Admin]
 *     summary: Override station geolocation
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lat, lng]
 *             properties:
 *               lat: { type: number }
 *               lng: { type: number }
 *     responses:
 *       200:
 *         description: Updated station
 */
router.patch(
  '/stations/:id/location',
  [
    param('id').isMongoId(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const { lat, lng } = req.body;
    const station = await Station.findByIdAndUpdate(
      req.params.id,
      { lat, lng, geohash: encodeGeohash(lat, lng, 7) },
      { new: true }
    );
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });
    res.json({ success: true, station });
  }
);

// ─── Rider Management ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/riders:
 *   get:
 *     tags: [Admin]
 *     summary: List riders with optional KYC status filter
 *     parameters:
 *       - in: query
 *         name: kycStatus
 *         schema: { type: string, enum: [pending, approved, rejected] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Paginated riders
 */
router.get('/riders', async (req: AuthRequest, res: Response) => {
  const { kycStatus, page = '1', limit = '20' } = req.query as Record<string, string>;
  const filter = kycStatus ? { kycStatus } : {};
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [riders, total] = await Promise.all([
    Rider.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).select('-passwordHash'),
    Rider.countDocuments(filter),
  ]);

  res.json({ success: true, riders, pagination: { page: parseInt(page), total } });
});

/**
 * @swagger
 * /api/v1/admin/riders/{id}/kyc:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve or reject rider KYC (notifies rider via SMS + push)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kycStatus]
 *             properties:
 *               kycStatus: { type: string, enum: [approved, rejected] }
 *               reason:    { type: string }
 *     responses:
 *       200:
 *         description: Updated rider
 */
router.patch(
  '/riders/:id/kyc',
  [
    param('id').isMongoId(),
    body('kycStatus').isIn(['approved', 'rejected']),
    body('reason').optional().isString(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const { kycStatus, reason } = req.body;
    const rider = await Rider.findByIdAndUpdate(
      req.params.id,
      { kycStatus, ...(reason && { kycRejectionReason: reason }) },
      { new: true }
    );
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    // Notify rider via SMS + push
    const smsText = kycStatus === 'approved'
      ? `GasGo: Your KYC has been approved! You can now go online and start delivering.`
      : `GasGo: Your KYC was not approved. Reason: ${reason || 'Please contact support.'}`;

    await sendSMS(rider.phone, smsText).catch(console.error);

    if (rider.fcmToken) {
      await sendPushNotification(rider.fcmToken, {
        title: kycStatus === 'approved' ? '✅ KYC Approved' : '❌ KYC Rejected',
        body: smsText,
        data: { screen: 'profile' },
      }).catch(console.error);
    }

    res.json({ success: true, rider });
  }
);

/**
 * @swagger
 * /api/v1/admin/riders/{id}/status:
 *   patch:
 *     tags: [Admin]
 *     summary: Suspend or ban a rider (forces offline)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [active, suspended, banned] }
 *     responses:
 *       200:
 *         description: Updated rider
 */
router.patch(
  '/riders/:id/status',
  [param('id').isMongoId(), body('status').isIn(['active', 'suspended', 'banned'])],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const { status } = req.body;
    const update: Record<string, unknown> = { isActive: status === 'active' };
    // Force offline if suspended/banned
    if (status !== 'active') update.status = 'offline';

    const rider = await Rider.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    res.json({ success: true, rider });
  }
);

// ─── Order Management / Disputes ─────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/orders:
 *   get:
 *     tags: [Admin]
 *     summary: List all orders (dispute management)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, accepted, at_station, en_route, delivered, cancelled] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Paginated orders
 */
router.get(
  '/orders',
  [
    query('status').optional().isIn(['pending', 'accepted', 'at_station', 'en_route', 'delivered', 'cancelled']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const { status, page = '1', limit = '20' } = req.query as Record<string, string>;
    const filter = status ? { status } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('userId', 'name phone')
        .populate('stationId', 'name address')
        .populate('riderId', 'name phone'),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, orders, pagination: { page: parseInt(page), total } });
  }
);

/**
 * @swagger
 * /api/v1/admin/orders/{id}/refund:
 *   post:
 *     tags: [Admin]
 *     summary: Manually trigger a Paystack refund for an order
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Refund initiated
 *       400:
 *         description: Already refunded, cash order, or no reference
 */
router.post(
  '/orders/:id/refund',
  [param('id').isMongoId()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.paymentStatus === 'refunded') {
      return res.status(400).json({ success: false, message: 'Order already refunded' });
    }
    if (order.paymentMethod === 'cash') {
      return res.status(400).json({ success: false, message: 'Cash orders cannot be refunded via platform' });
    }
    if (!order.paystackReference) {
      return res.status(400).json({ success: false, message: 'No payment reference found' });
    }

    await initiateRefund(order.paystackReference);
    order.paymentStatus = 'refunded';
    order.statusHistory.push({
      status: order.status,
      triggeredBy: 'admin',
      triggeredById: new mongoose.Types.ObjectId(req.user!.id),
      timestamp: new Date(),
      note: 'Manual refund issued by admin',
    });
    await order.save();

    res.json({ success: true, message: 'Refund initiated' });
  }
);

/**
 * @swagger
 * /api/v1/admin/orders/{id}/cancel:
 *   patch:
 *     tags: [Admin]
 *     summary: Force cancel any non-terminal order
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Order cancelled
 */
router.patch(
  '/orders/:id/cancel',
  [param('id').isMongoId(), body('reason').trim().notEmpty()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'delivered' || order.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Cannot cancel a ${order.status} order` });
    }

    order.status = 'cancelled';
    order.cancelledBy = 'admin';
    order.cancellationReason = req.body.reason;
    order.statusHistory.push({
      status: 'cancelled',
      triggeredBy: 'admin',
      triggeredById: new mongoose.Types.ObjectId(req.user!.id),
      timestamp: new Date(),
      note: req.body.reason,
    });

    // Restore stock for each line item
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

    // Free rider
    if (order.riderId) {
      await Rider.findByIdAndUpdate(order.riderId, { status: 'available', currentOrderId: null });
    }

    // Refund if captured
    if (order.paymentStatus === 'captured' && order.paystackReference) {
      await initiateRefund(order.paystackReference).catch(console.error);
      order.paymentStatus = 'refunded';
    }

    await order.save();
    emitOrderStatus(order._id.toString(), 'cancelled');

    res.json({ success: true, message: 'Order cancelled' });
  }
);

// ─── Pricing Controls ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/pricing:
 *   get:
 *     tags: [Admin]
 *     summary: Get current platform pricing config
 *     responses:
 *       200:
 *         description: Pricing config
 *   patch:
 *     tags: [Admin]
 *     summary: Update platform pricing (surge, delivery fee, caps, freeze)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               deliveryFeeFlat:   { type: number }
 *               surgeMultiplier:   { type: number, minimum: 1, maximum: 5 }
 *               surgeActive:       { type: boolean }
 *               surgeReason:       { type: string }
 *               priceFreezeActive: { type: boolean }
 *               minPriceCaps:      { type: array }
 *               maxPriceCaps:      { type: array }
 *     responses:
 *       200:
 *         description: Updated pricing config
 */
router.get('/pricing', async (_req: AuthRequest, res: Response) => {
  const config = await PricingConfig.findOne().sort({ createdAt: -1 });
  res.json({ success: true, pricing: config || {} });
});

/** PATCH /api/v1/admin/pricing */
router.patch(
  '/pricing',
  [
    body('deliveryFeeFlat').optional().isFloat({ min: 0 }),
    body('surgeMultiplier').optional().isFloat({ min: 1.0, max: 5.0 }),
    body('surgeActive').optional().isBoolean(),
    body('surgeReason').optional().isString(),
    body('priceFreezeActive').optional().isBoolean(),
    body('minPriceCaps').optional().isArray(),
    body('maxPriceCaps').optional().isArray(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const update = { ...req.body, updatedBy: req.user!.id };
    const config = await PricingConfig.findOneAndUpdate(
      {},
      { $set: update },
      { new: true, upsert: true }
    );

    res.json({ success: true, pricing: config });
  }
);

// ─── User Management ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List users with optional search
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by name or phone
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Paginated users
 */
router.get('/users', async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '20', search } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = search
    ? { $or: [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search } }] }
    : {};

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).select('-passwordHash'),
    User.countDocuments(filter),
  ]);

  res.json({ success: true, users, pagination: { page: parseInt(page), total } });
});

export default router;
