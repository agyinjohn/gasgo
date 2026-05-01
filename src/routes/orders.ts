import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Order } from '../models/Order';
import { Station } from '../models/Station';
import { User } from '../models/User';
import { PricingConfig } from '../models/PricingConfig';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { generateDeliveryOTP } from '../services/otpService';
import { dispatchOrder, markDispatchAccepted, markDispatchDeclined } from '../services/dispatchService';
import { emitOrderStatus } from '../services/realtimeService';
import { generatePaymentReference, initializePayment, transferToBeneficiary } from '../services/paymentService';
import { sendPushNotification, sendSMS, SMS_TEMPLATES, ORDER_STATUS_MESSAGES } from '../services/notificationService';
import { CONSTANTS } from '../config/constants';
import { Payout } from '../models/Payout';
import { LoyaltyTransaction, LOYALTY_EARN_RATE, LOYALTY_REDEEM_RATE, LOYALTY_MIN_REDEEM } from '../models/LoyaltyTransaction';

const router = Router();

router.use(authenticate);

function ve(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ success: false, errors: errors.array() }); return true; }
  return false;
}

// ─── Create Order ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/orders:
 *   post:
 *     tags: [Orders]
 *     summary: Place a new order
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOrderRequest'
 *     responses:
 *       201:
 *         description: Order created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean }
 *                 order:    { $ref: '#/components/schemas/Order' }
 *                 payment:  { type: object }
 *       400:
 *         description: Validation error or station closed
 *       503:
 *         description: Price freeze active
 *   get:
 *     tags: [Orders]
 *     summary: List orders for current user/rider/station
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated orders
 */
router.post(
  '/',
  [
    body('stationId').isMongoId(),
    body('cylinders').isArray({ min: 1 }).withMessage('At least one cylinder required'),
    body('cylinders.*.size').isIn([3, 6, 12]),
    body('cylinders.*.quantity').isInt({ min: 1, max: 20 }),
    body('orderType').isIn(['delivery', 'exchange']),
    body('deliveryAddress.street').trim().notEmpty(),
    body('deliveryAddress.city').trim().notEmpty(),
    body('deliveryAddress.lat').isFloat({ min: -90, max: 90 }),
    body('deliveryAddress.lng').isFloat({ min: -180, max: 180 }),
    body('paymentMethod').isIn(['mobile_money', 'card', 'cash']),
    body('redeemPoints').optional().isInt({ min: 0 }),
    body('scheduledFor').optional().isISO8601().toDate(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const { stationId, cylinders, orderType, deliveryAddress, paymentMethod, paymentProvider, redeemPoints, scheduledFor } = req.body;
    const userId = req.user!.id;

    // Validate scheduledFor is in the future (min 30 min from now)
    if (scheduledFor) {
      const minSchedule = new Date(Date.now() + 30 * 60 * 1000);
      if (new Date(scheduledFor) < minSchedule) {
        return res.status(400).json({ success: false, message: 'Scheduled time must be at least 30 minutes from now' });
      }
    }

    const station = await Station.findById(stationId);
    if (!station || station.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Station not found or inactive' });
    }

    // Check operating hours
    const now = new Date();
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const today = days[now.getDay()];
    const hours = station.operatingHours[today];
    if (!hours.isOpen) {
      return res.status(400).json({ success: false, message: 'Station is closed today' });
    }

    // ── Validate each cylinder line item against station stock ──────────────────
    // Deduplicate sizes (merge quantities if same size appears twice)
    const sizeMap = new Map<number, number>();
    for (const item of cylinders as { size: number; quantity: number }[]) {
      sizeMap.set(item.size, (sizeMap.get(item.size) ?? 0) + item.quantity);
    }

    for (const [size, quantity] of sizeMap) {
      const listing = station.cylinderListings.find((l) => l.size === size);
      if (!listing || !listing.isAvailable || listing.stockCount < quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${size}kg cylinder (requested ${quantity}, available ${listing?.stockCount ?? 0})`,
        });
      }
    }

    // ── Pricing: fetch config, apply surge + caps ──────────────────────────
    const pricingConfig = await PricingConfig.findOne().sort({ createdAt: -1 });

    if (pricingConfig?.priceFreezeActive) {
      return res.status(503).json({ success: false, message: 'Orders are temporarily paused due to a price freeze. Please try again shortly.' });
    }

    const surgeMultiplier = pricingConfig?.surgeActive ? (pricingConfig.surgeMultiplier ?? 1) : 1;
    const surgeApplied = surgeMultiplier > 1;
    const surgeReason  = surgeApplied ? (pricingConfig?.surgeReason ?? 'High demand') : undefined;

    // Build cylinder line items with pricing
    const cylinderLineItems = [];
    let cylinderSubtotal = 0;

    for (const [size, quantity] of sizeMap) {
      const listing = station.cylinderListings.find((l) => l.size === size)!;
      let unitPrice = orderType === 'exchange' ? listing.exchangePrice : listing.fillPrice;

      // Apply surge
      unitPrice = +(unitPrice * surgeMultiplier).toFixed(2);

      // Enforce min cap
      if (pricingConfig?.minPriceCaps?.length) {
        const cap = pricingConfig.minPriceCaps.find((c) => c.size === size);
        if (cap && unitPrice < cap.min) unitPrice = cap.min;
      }
      // Enforce max cap
      if (pricingConfig?.maxPriceCaps?.length) {
        const cap = pricingConfig.maxPriceCaps.find((c) => c.size === size);
        if (cap && unitPrice > cap.max) unitPrice = cap.max;
      }

      const subtotal = +(unitPrice * quantity).toFixed(2);
      cylinderSubtotal = +(cylinderSubtotal + subtotal).toFixed(2);
      cylinderLineItems.push({ size, quantity, unitPrice, subtotal });
    }

    // ── Delivery fee scaled by total cylinder count ──────────────────────────
    const baseFee = +(pricingConfig?.deliveryFeeFlat ?? 5).toFixed(2);
    const totalQty = [...sizeMap.values()].reduce((a, b) => a + b, 0);
    const feeMultiplier = totalQty === 1 ? 1 : totalQty === 2 ? 1.5 : 2.0;
    const deliveryFee = +(baseFee * feeMultiplier).toFixed(2);

    const totalAmount = +(cylinderSubtotal + deliveryFee).toFixed(2);
    const commissionPct = station.commissionPct;
    const commissionAmount = +((totalAmount * commissionPct) / 100).toFixed(2);
    const stationPayout = +(totalAmount - commissionAmount).toFixed(2);

    // ── Loyalty redemption ───────────────────────────────────────────────
    let loyaltyDiscount = 0;
    let loyaltyPointsRedeemed = 0;

    if (redeemPoints && redeemPoints >= LOYALTY_MIN_REDEEM) {
      const user = await User.findById(userId).select('loyaltyPoints');
      const available = user?.loyaltyPoints ?? 0;
      const toRedeem = Math.min(redeemPoints, available);
      if (toRedeem >= LOYALTY_MIN_REDEEM) {
        loyaltyDiscount = +(toRedeem / LOYALTY_REDEEM_RATE).toFixed(2);
        loyaltyDiscount = Math.min(loyaltyDiscount, totalAmount);
        loyaltyPointsRedeemed = Math.round(loyaltyDiscount * LOYALTY_REDEEM_RATE);
      }
    }

    const finalAmount = +(totalAmount - loyaltyDiscount).toFixed(2);

    const { code: otpCode, expiresAt: otpExpiresAt } = generateDeliveryOTP();

    const order = await Order.create({
      userId,
      stationId: station._id,
      cylinders: cylinderLineItems,
      orderType,
      cylinderSubtotal,
      deliveryFee,
      totalAmount,
      commissionPct,
      commissionAmount,
      stationPayout,
      deliveryAddress,
      paymentMethod,
      paymentProvider,
      otpCode,
      otpExpiresAt,
      surgeMultiplier: surgeApplied ? surgeMultiplier : 1,
      loyaltyDiscount,
      loyaltyPointsRedeemed,
      isScheduled: !!scheduledFor,
      scheduledFor: scheduledFor || undefined,
      status: scheduledFor ? 'scheduled' : 'pending',
      statusHistory: [{
        status: scheduledFor ? 'scheduled' : 'pending',
        triggeredBy: 'user',
        triggeredById: userId,
        timestamp: new Date(),
        note: scheduledFor ? `Scheduled for ${new Date(scheduledFor).toISOString()}` : undefined,
      }],
    });

    // Decrement stock for each line item
    for (const [size, quantity] of sizeMap) {
      const listing = station.cylinderListings.find((l) => l.size === size)!;
      listing.stockCount -= quantity;
      listing.isAvailable = listing.stockCount > 0 && !listing.isPaused;
    }
    await station.save();

    // Deduct redeemed points from user balance
    if (loyaltyPointsRedeemed > 0) {
      const user = await User.findById(userId);
      if (user) {
        user.loyaltyPoints = Math.max(0, user.loyaltyPoints - loyaltyPointsRedeemed);
        await user.save();
        await LoyaltyTransaction.create({
          userId,
          orderId: order._id,
          type: 'redeem',
          points: -loyaltyPointsRedeemed,
          balanceAfter: user.loyaltyPoints,
          description: `Redeemed ${loyaltyPointsRedeemed} points for GH₵${loyaltyDiscount} discount`,
        });
      }
    }

    // Increment user total orders
    await User.findByIdAndUpdate(userId, { $inc: { totalOrders: 1 } });

    let paymentResponse = null;
    if (paymentMethod !== 'cash') {
      const user = await User.findById(userId).select('phone email');
      const reference = generatePaymentReference(order._id.toString());
      const payment = await initializePayment({
        email: user?.email || `${user?.phone}@gasgo.app`,
        amountGHS: finalAmount,
        reference,
        callbackUrl: `${process.env.FRONTEND_URL}/user/orders/${order._id}?payment=callback`,
        metadata: { orderId: order._id.toString() },
        mobileNumber: paymentMethod === 'mobile_money' ? user?.phone : undefined,
        provider: paymentProvider,
      });
      order.paystackReference = reference;
      await order.save();
      paymentResponse = payment;
    }

    // Dispatch rider immediately — skip for scheduled orders
    if (!scheduledFor) {
      dispatchOrder(order._id.toString()).catch(console.error);
    }

    res.status(201).json({
      success: true,
      order: {
        id: order._id,
        status: order.status,
        cylinders: cylinderLineItems,
        cylinderSubtotal,
        totalAmount,
        finalAmount,
        deliveryFee,
        totalCylinders: totalQty,
        surgeApplied,
        surgeMultiplier: surgeApplied ? surgeMultiplier : undefined,
        surgeReason,
        loyaltyDiscount,
        loyaltyPointsRedeemed,
        isScheduled: !!scheduledFor,
        scheduledFor: scheduledFor || undefined,
        otpCode: process.env.NODE_ENV === 'development' ? otpCode : undefined,
      },
      payment: paymentResponse,
    });
  }
);

// ─── Get Orders ───────────────────────────────────────────────────────────────

/** GET /api/v1/orders — current user's orders */
router.get('/', async (req: AuthRequest, res: Response) => {
  const { role, id } = req.user!;
  const page = parseInt(req.query.page as string || '1');
  const limit = parseInt(req.query.limit as string || '10');
  const skip = (page - 1) * limit;

  let filter: Record<string, unknown> = {};
  if (role === 'user') filter = { userId: id };
  else if (role === 'rider') filter = { riderId: id };
  else if (role === 'station') filter = { stationId: (req.user as any).stationId ?? req.query.stationId };
  else if (role === 'admin') filter = {}; // admin sees all

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('stationId', 'name address')
      .populate('riderId', 'name phone profilePhoto ratingAvg'),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   get:
 *     tags: [Orders]
 *     summary: Get a single order by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order detail
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 */
router.get('/:id', [param('id').isMongoId()], async (req: AuthRequest, res: Response) => {
  if (ve(req, res)) return;

  const order = await Order.findById(req.params.id)
    .populate('stationId', 'name address lat lng')
    .populate('riderId', 'name phone profilePhoto ratingAvg vehicleType location')
    .populate('userId', 'name phone');

  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  // Ownership check
  const { role, id } = req.user!;
  const ownedByUser    = role === 'user'    && order.userId.toString()    === id;
  const ownedByRider   = role === 'rider'   && order.riderId?.toString()  === id;
  const ownedByStation = role === 'station' && order.stationId.toString() === (req.user as any).stationId;
  const isAdmin        = role === 'admin';

  if (!ownedByUser && !ownedByRider && !ownedByStation && !isAdmin) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  res.json({ success: true, order });
});

// ─── Status Transitions ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/orders/{id}/status:
 *   patch:
 *     tags: [Orders]
 *     summary: Update order status (rider/station/user role-gated)
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
 *               status: { type: string, enum: [accepted, at_station, en_route, cancelled] }
 *               note:   { type: string }
 *     responses:
 *       200:
 *         description: Updated status
 *       403:
 *         description: Forbidden
 */
router.patch(
  '/:id/status',
  [param('id').isMongoId(), body('status').isIn(['accepted', 'at_station', 'en_route', 'cancelled'])],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const { status, note } = req.body;
    const { role, id } = req.user!;

    // ── Authorization per role ──────────────────────────────────────────────
    // Users can only cancel their own orders
    if (role === 'user') {
      if (order.userId.toString() !== id) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      if (status !== 'cancelled') {
        return res.status(403).json({ success: false, message: 'Users can only cancel orders' });
      }
    }

    // Riders can only update orders assigned to them (or accept a pending order)
    if (role === 'rider') {
      const isAssigned = order.riderId?.toString() === id;
      const isAccepting = status === 'accepted' && order.status === 'pending';
      if (!isAssigned && !isAccepting) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }

    // Stations can only update orders belonging to their station
    if (role === 'station') {
      const stationId = (req.user as any).stationId;
      if (!stationId || order.stationId.toString() !== stationId) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }

    // Validate transitions
    const TRANSITIONS: Record<string, string[]> = {
      pending:    ['accepted', 'cancelled'],
      accepted:   ['at_station', 'cancelled'],
      at_station: ['en_route', 'cancelled'],
      en_route:   ['delivered', 'cancelled'],
    };

    if (!TRANSITIONS[order.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from ${order.status} to ${status}`,
      });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      triggeredBy: role as 'user' | 'rider' | 'station' | 'admin',
      triggeredById: new mongoose.Types.ObjectId(id),
      timestamp: new Date(),
      note,
    });

    if (status === 'accepted' && role === 'rider') {
      order.riderId = new mongoose.Types.ObjectId(id);
      const { Rider } = await import('../models/Rider');
      await Rider.findByIdAndUpdate(id, { status: 'busy', currentOrderId: order._id });
      await markDispatchAccepted(order._id.toString(), id);
    }

    if (status === 'cancelled') {
      order.cancellationReason = note;
      order.cancelledBy = role as 'user' | 'station' | 'admin';

      // Restore stock for each line item — respect isPaused state
      const station = await Station.findById(order.stationId);
      if (station) {
        for (const item of order.cylinders) {
          const listing = station.cylinderListings.find((l) => l.size === item.size);
          if (listing) {
            listing.stockCount += item.quantity;
            listing.isAvailable = listing.stockCount > 0 && !listing.isPaused;
          }
        }
        await station.save();
      }

      // Free rider
      if (order.riderId) {
        const { Rider } = await import('../models/Rider');
        await Rider.findByIdAndUpdate(order.riderId, { status: 'available', currentOrderId: null });
      }

      // Trigger refund for captured payments
      if (order.paymentStatus === 'captured' && order.paystackReference) {
        try {
          const { initiateRefund } = await import('../services/paymentService');
          await initiateRefund(order.paystackReference);
          order.paymentStatus = 'refunded';
        } catch (err) {
          console.error('[Cancellation] Refund failed:', err);
        }
      } else if (order.paymentMethod === 'cash' || order.paymentStatus === 'pending') {
        order.paymentStatus = 'refunded'; // nothing to refund
      }
    }

    await order.save();

    // Real-time broadcast
    emitOrderStatus(order._id.toString(), status);

    // Push notification to user
    const msgTemplate = ORDER_STATUS_MESSAGES[status];
    if (msgTemplate) {
      const user = await User.findById(order.userId).select('fcmToken phone');
      if (user?.fcmToken) {
        await sendPushNotification(user.fcmToken, { ...msgTemplate, data: { orderId: order._id.toString() } });
      }
    }

    res.json({ success: true, status: order.status });
  }
);

// ─── Rider Decline Order ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/orders/{id}/decline:
 *   post:
 *     tags: [Orders]
 *     summary: Rider declines a dispatched order (triggers next rider dispatch)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order declined
 *       403:
 *         description: Only riders can decline
 */
/**
 * POST /api/v1/orders/:id/decline
 * Rider explicitly declines a dispatched order.
 */
router.post(
  '/:id/decline',
  [param('id').isMongoId()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    if (req.user!.role !== 'rider') {
      return res.status(403).json({ success: false, message: 'Only riders can decline orders' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Order is no longer pending' });
    }

    await markDispatchDeclined(order._id.toString(), req.user!.id);
    res.json({ success: true, message: 'Order declined' });
  }
);

// ─── OTP Delivery Confirmation ────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/orders/{id}/confirm-delivery:
 *   post:
 *     tags: [Orders]
 *     summary: User confirms delivery with 4-digit OTP
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
 *             required: [otp]
 *             properties:
 *               otp: { type: string, minLength: 4, maxLength: 4 }
 *     responses:
 *       200:
 *         description: Delivery confirmed, payouts triggered
 *       400:
 *         description: Invalid OTP or max attempts reached
 */
/**
 * POST /api/v1/orders/:id/confirm-delivery
 * User submits OTP to confirm receipt.
 */
router.post(
  '/:id/confirm-delivery',
  [param('id').isMongoId(), body('otp').isLength({ min: 4, max: 4 }).isNumeric()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only the order's user can confirm delivery
    if (order.userId.toString() !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    if (order.status !== 'en_route') {
      return res.status(400).json({ success: false, message: 'Order is not en route' });
    }

    if (order.otpAttempts >= CONSTANTS.OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ success: false, message: 'Maximum OTP attempts reached. Contact support.' });
    }

    if (order.otpCode !== req.body.otp || order.otpExpiresAt < new Date()) {
      order.otpAttempts += 1;
      await order.save();
      return res.status(400).json({
        success: false,
        message: `Invalid or expired OTP. ${CONSTANTS.OTP_MAX_ATTEMPTS - order.otpAttempts} attempt(s) remaining.`,
      });
    }

    order.status = 'delivered';
    order.otpVerifiedAt = new Date();
    order.otpAttempts += 1;
    order.paymentStatus = 'released';
    order.statusHistory.push({
      status: 'delivered',
      triggeredBy: 'user',
      triggeredById: new mongoose.Types.ObjectId(req.user!.id),
      timestamp: new Date(),
    });
    await order.save();

    // Free up rider
    if (order.riderId) {
      const { Rider } = await import('../models/Rider');
      const rider = await Rider.findByIdAndUpdate(
        order.riderId,
        { status: 'available', currentOrderId: null, $inc: { totalTrips: 1, totalEarnings: order.stationPayout * 0.15 } },
        { new: true }
      );

      // Create rider payout record
      const riderEarning = +(order.stationPayout * 0.15).toFixed(2);
      const riderPayout = await Payout.create({
        recipientType: 'rider',
        recipientId: order.riderId,
        orderId: order._id,
        amountGHS: riderEarning,
        status: 'pending',
      });

      // Auto-transfer if rider has a registered bank account
      if (rider?.bankAccount?.recipientCode) {
        try {
          const ref = generatePaymentReference(riderPayout._id.toString());
          const result = await transferToBeneficiary({
            amountGHS: riderEarning,
            recipientCode: rider.bankAccount.recipientCode,
            reason: `GasGo rider payout — Order ${order._id.toString().slice(-6).toUpperCase()}`,
            reference: ref,
          });
          riderPayout.status = 'processing';
          riderPayout.paystackTransferCode = result.transferCode;
          riderPayout.paystackReference = ref;
          await riderPayout.save();
        } catch (err) {
          console.error('[Payout] Rider transfer failed:', err);
        }
      }
    }

    // Create station payout record
    await Payout.create({
      recipientType: 'station',
      recipientId: order.stationId,
      orderId: order._id,
      amountGHS: order.stationPayout,
      status: 'pending',
    });

    // Update station stats
    await Station.findByIdAndUpdate(order.stationId, { $inc: { totalOrders: 1 } });

    // ── Earn loyalty points (1 point per GHS paid after discount) ────────────────
    const amountPaid = +(order.totalAmount - (order.loyaltyDiscount ?? 0)).toFixed(2);
    const pointsEarned = Math.floor(amountPaid * LOYALTY_EARN_RATE);
    if (pointsEarned > 0) {
      const user = await User.findById(order.userId);
      if (user) {
        user.loyaltyPoints = (user.loyaltyPoints ?? 0) + pointsEarned;
        await user.save();
        await LoyaltyTransaction.create({
          userId: order.userId,
          orderId: order._id,
          type: 'earn',
          points: pointsEarned,
          balanceAfter: user.loyaltyPoints,
          description: `Earned ${pointsEarned} points for order #${order._id.toString().slice(-6).toUpperCase()}`,
        });
        // Update order with points earned
        await Order.findByIdAndUpdate(order._id, { loyaltyPointsEarned: pointsEarned });
      }
    }

    emitOrderStatus(order._id.toString(), 'delivered');

    // TODO: trigger Paystack payout to station
    res.json({ success: true, message: 'Delivery confirmed. Thank you!' });
  }
);

// ─── Rate Rider ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/orders/{id}/rate:
 *   post:
 *     tags: [Orders]
 *     summary: Rate the rider after delivery
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
 *             required: [rating]
 *             properties:
 *               rating:  { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string }
 *     responses:
 *       200:
 *         description: Rating submitted
 */
/**
 * POST /api/v1/orders/:id/rate
 */
router.post(
  '/:id/rate',
  [param('id').isMongoId(), body('rating').isInt({ min: 1, max: 5 }), body('comment').optional().isString()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only the order's user can rate
    if (order.userId.toString() !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    if (order.status !== 'delivered') return res.status(400).json({ success: false, message: 'Order not delivered yet' });
    if (order.riderRating) return res.status(400).json({ success: false, message: 'Already rated' });

    const { rating, comment } = req.body;
    order.riderRating = rating;
    order.riderRatingComment = comment;
    order.ratedAt = new Date();
    await order.save();

    if (order.riderId) {
      const { Rider } = await import('../models/Rider');
      const rider = await Rider.findById(order.riderId);
      if (rider) {
        const newTotal = rider.totalRatings + 1;
        rider.ratingAvg = (rider.ratingAvg * rider.totalRatings + rating) / newTotal;
        rider.totalRatings = newTotal;
        await rider.save();
      }
    }

    res.json({ success: true, message: 'Rating submitted' });
  }
);

/**
 * @swagger
 * /api/v1/orders/{id}/rate-station:
 *   post:
 *     tags: [Orders]
 *     summary: Rate the station after delivery
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
 *             required: [rating]
 *             properties:
 *               rating:  { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string }
 *     responses:
 *       200:
 *         description: Station rated
 */
// ─── Rate Station ─────────────────────────────────────────────────────

/**
 * POST /api/v1/orders/:id/rate-station
 */
router.post(
  '/:id/rate-station',
  [param('id').isMongoId(), body('rating').isInt({ min: 1, max: 5 }), body('comment').optional().isString()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Order not delivered yet' });
    }
    if (order.stationRating) {
      return res.status(400).json({ success: false, message: 'Station already rated for this order' });
    }

    const { rating, comment } = req.body;
    order.stationRating = rating;
    order.stationRatingComment = comment;
    order.stationRatedAt = new Date();
    await order.save();

    // Update station rolling average
    const station = await Station.findById(order.stationId);
    if (station) {
      const newTotal = station.totalRatings + 1;
      station.ratingAvg = +((station.ratingAvg * station.totalRatings + rating) / newTotal).toFixed(2);
      station.totalRatings = newTotal;
      await station.save();
    }

    res.json({ success: true, message: 'Station rated' });
  }
);

export default router;
