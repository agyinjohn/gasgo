import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Rider } from '../models/Rider';
import { Order } from '../models/Order';
import { Payout } from '../models/Payout';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { io } from '../services/realtimeService';
import { createTransferRecipient, transferToBeneficiary, generatePaymentReference } from '../services/paymentService';

const router = Router();
router.use(authenticate);

function ve(req: Request, res: Response): boolean {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ success: false, errors: e.array() }); return true; }
  return false;
}

/**
 * @swagger
 * /api/v1/riders/me:
 *   get:
 *     tags: [Riders]
 *     summary: Get rider profile
 *     responses:
 *       200:
 *         description: Rider profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Rider'
 */
router.get('/me', async (req: AuthRequest, res: Response) => {
  const rider = await Rider.findById(req.user!.id).select('-passwordHash');
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
  res.json({ success: true, rider });
});

/**
 * @swagger
 * /api/v1/riders/status:
 *   patch:
 *     tags: [Riders]
 *     summary: Set rider online/offline/on_break status
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [offline, available, on_break] }
 *     responses:
 *       200:
 *         description: Updated status
 *       403:
 *         description: KYC not approved
 */
router.patch(
  '/status',
  [body('status').isIn(['offline', 'available', 'on_break'])],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const rider = await Rider.findById(req.user!.id);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    if (rider.kycStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC approval required' });
    }

    rider.status = req.body.status;
    await rider.save();
    res.json({ success: true, status: rider.status });
  }
);

/**
 * @swagger
 * /api/v1/riders/location:
 *   patch:
 *     tags: [Riders]
 *     summary: Update rider GPS location (broadcasts to active order room)
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
 *         description: Location updated
 */
router.patch(
  '/location',
  [body('lat').isFloat({ min: -90, max: 90 }), body('lng').isFloat({ min: -180, max: 180 })],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const { lat, lng } = req.body;
    const riderId = req.user!.id;

    await Rider.findByIdAndUpdate(riderId, {
      'location.lat': lat,
      'location.lng': lng,
      'location.updatedAt': new Date(),
    });

    // Broadcast to the active order's socket room
    const activeOrder = await Order.findOne(
      { riderId, status: { $in: ['accepted', 'at_station', 'en_route'] } },
      '_id'
    );
    if (activeOrder) {
      io.to(`order:${activeOrder._id}`).emit('rider:location:update', {
        lat, lng, updatedAt: new Date(),
      });
    }

    res.json({ success: true });
  }
);

/**
 * @swagger
 * /api/v1/riders/fcm-token:
 *   patch:
 *     tags: [Riders]
 *     summary: Update rider FCM push notification token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: Token updated
 */
router.patch('/fcm-token', [body('token').notEmpty()], async (req: AuthRequest, res: Response) => {
  await Rider.findByIdAndUpdate(req.user!.id, { fcmToken: req.body.token });
  res.json({ success: true });
});

/**
 * @swagger
 * /api/v1/riders/dashboard:
 *   get:
 *     tags: [Riders]
 *     summary: Get rider dashboard — today earnings, stats, active order
 *     responses:
 *       200:
 *         description: Dashboard data
 */
router.get('/dashboard', async (req: AuthRequest, res: Response) => {
  const riderId = new mongoose.Types.ObjectId(req.user!.id);
  const rider = await Rider.findById(riderId).select('totalTrips ratingAvg totalEarnings status');
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const [todayOrders, todayEarningsResult, activeOrder] = await Promise.all([
    Order.countDocuments({ riderId, status: 'delivered', createdAt: { $gte: today } }),
    Order.aggregate([
      { $match: { riderId, status: 'delivered', createdAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: { $multiply: ['$stationPayout', 0.15] } } } },
    ]),
    Order.findOne(
      { riderId, status: { $in: ['accepted', 'at_station', 'en_route'] } },
      '_id status cylinders orderType deliveryAddress stationId'
    ).populate('stationId', 'name address lat lng'),
  ]);

  res.json({
    success: true,
    dashboard: {
      todayTrips: todayOrders,
      todayEarnings: todayEarningsResult[0]?.total || 0,
      totalTrips: rider?.totalTrips,
      ratingAvg: rider?.ratingAvg,
      totalEarnings: rider?.totalEarnings,
      status: rider?.status,
      activeOrder: activeOrder || null,
    },
  });
});

/**
 * @swagger
 * /api/v1/riders/orders:
 *   get:
 *     tags: [Riders]
 *     summary: Get rider delivery history
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated delivery history
 */
router.get('/orders', async (req: AuthRequest, res: Response) => {
  const riderId = req.user!.id;
  const page  = parseInt(req.query.page  as string || '1');
  const limit = parseInt(req.query.limit as string || '20');
  const skip  = (page - 1) * limit;

  const [orders, total] = await Promise.all([
    Order.find({ riderId, status: { $in: ['delivered', 'cancelled'] } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('stationId', 'name address')
      .populate('userId', 'name phone'),
    Order.countDocuments({ riderId }),
  ]);

  res.json({ success: true, orders, pagination: { page, limit, total } });
});

/**
 * @swagger
 * /api/v1/riders/payouts:
 *   get:
 *     tags: [Riders]
 *     summary: Get rider payout history
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Paginated payout history
 */
router.get('/payouts', async (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string || '1');
  const limit = parseInt(req.query.limit as string || '20');
  const skip  = (page - 1) * limit;

  const [payouts, total] = await Promise.all([
    Payout.find({ recipientType: 'rider', recipientId: req.user!.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('orderId', 'cylinders orderType createdAt'),
    Payout.countDocuments({ recipientType: 'rider', recipientId: req.user!.id }),
  ]);

  res.json({ success: true, payouts, pagination: { page, limit, total } });
});

/**
 * @swagger
 * /api/v1/riders/bank-account:
 *   patch:
 *     tags: [Riders]
 *     summary: Save bank/mobile money account for payouts
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, accountNumber, accountName]
 *             properties:
 *               provider:      { type: string, example: mtn }
 *               accountNumber: { type: string, example: '0244123456' }
 *               accountName:   { type: string, example: Kwame Mensah }
 *     responses:
 *       200:
 *         description: Bank account saved
 */
router.patch(
  '/bank-account',
  [
    body('provider').trim().notEmpty(),
    body('accountNumber').trim().notEmpty(),
    body('accountName').trim().notEmpty(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const { provider, accountNumber, accountName } = req.body;

    // Register as Paystack transfer recipient
    let recipientCode: string | undefined;
    try {
      recipientCode = await createTransferRecipient({
        type: 'mobile_money',
        name: accountName,
        accountNumber,
        mobileProvider: provider.toLowerCase() as 'mtn' | 'vod' | 'tgo',
      });
    } catch (err) {
      console.error('[BankAccount] Paystack recipient creation failed:', err);
      // Save details even if Paystack registration fails — can retry later
    }

    const rider = await Rider.findByIdAndUpdate(
      req.user!.id,
      { bankAccount: { provider, accountNumber, accountName, recipientCode } },
      { new: true }
    ).select('bankAccount');

    res.json({ success: true, bankAccount: rider?.bankAccount });
  }
);

export default router;
