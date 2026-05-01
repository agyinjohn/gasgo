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

/** GET /api/v1/riders/me — rider profile */
router.get('/me', async (req: AuthRequest, res: Response) => {
  const rider = await Rider.findById(req.user!.id).select('-passwordHash');
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
  res.json({ success: true, rider });
});

/** PATCH /api/v1/riders/status — go online/offline */
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

/** PATCH /api/v1/riders/location — update GPS + broadcast to active order room */
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

/** PATCH /api/v1/riders/fcm-token */
router.patch('/fcm-token', [body('token').notEmpty()], async (req: AuthRequest, res: Response) => {
  await Rider.findByIdAndUpdate(req.user!.id, { fcmToken: req.body.token });
  res.json({ success: true });
});

/** GET /api/v1/riders/dashboard — earnings + stats */
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
      '_id status cylinderSize orderType deliveryAddress stationId'
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

/** GET /api/v1/riders/orders — delivery history */
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

/** GET /api/v1/riders/payouts — payout history */
router.get('/payouts', async (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string || '1');
  const limit = parseInt(req.query.limit as string || '20');
  const skip  = (page - 1) * limit;

  const [payouts, total] = await Promise.all([
    Payout.find({ recipientType: 'rider', recipientId: req.user!.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('orderId', 'cylinderSize orderType createdAt'),
    Payout.countDocuments({ recipientType: 'rider', recipientId: req.user!.id }),
  ]);

  res.json({ success: true, payouts, pagination: { page, limit, total } });
});

/** PATCH /api/v1/riders/bank-account — save bank/mobile money details */
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
