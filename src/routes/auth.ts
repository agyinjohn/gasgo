import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Rider } from '../models/Rider';
import { Admin } from '../models/Admin';
import { LoyaltyTransaction } from '../models/LoyaltyTransaction';
import { createOTP, verifyOTP } from '../services/otpService';
import { sendSMS, SMS_TEMPLATES } from '../services/notificationService';

const REFERRAL_REWARD_POINTS = 200; // points awarded to both referrer and new user

function generateReferralCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. "A3F2B1C4"
}

const router = Router();

function signToken(payload: object, expiresIn = '7d'): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn } as jwt.SignOptions);
}

function ve(req: Request, res: Response): boolean {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ success: false, errors: e.array() }); return true; }
  return false;
}

// User OTP
/**
 * @swagger
 * /api/v1/auth/user/send-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Send OTP to user phone
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SendOTPRequest'
 *     responses:
 *       200:
 *         description: OTP sent
 *       400:
 *         description: Validation error
 */
router.post('/user/send-otp',
  [body('phone').trim().isMobilePhone('any'), body('purpose').isIn(['registration','login'])],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone, purpose } = req.body;
    const code = await createOTP(phone, purpose);
    if (process.env.NODE_ENV === 'development') return res.json({ success: true, _devCode: code });
    await sendSMS(phone, SMS_TEMPLATES.otpVerification(code));
    res.json({ success: true, message: 'OTP sent' });
  }
);

// User Verify OTP
/**
 * @swagger
 * /api/v1/auth/user/verify-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Verify OTP and login or register user
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerifyOTPRequest'
 *     responses:
 *       200:
 *         description: Auth token + user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Invalid OTP
 */
router.post('/user/verify-otp',
  [body('phone').trim().isMobilePhone('any'), body('code').isLength({ min:4, max:6 }), body('purpose').isIn(['registration','login'])],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone, code, purpose, name, referralCode } = req.body;
    try {
      await verifyOTP(phone, code, purpose);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message || 'Invalid OTP' });
    }

    let user = await User.findOne({ phone });
    const isNewUser = !user;

    if (!user) {
      const safeName = typeof name === 'string' && name.trim() ? name.trim() : `User ${phone.slice(-4)}`;

      // Resolve referrer
      let referredBy: mongoose.Types.ObjectId | undefined;
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase().trim() });
        if (referrer) referredBy = referrer._id;
      }

      // Generate unique referral code for new user
      let newCode = generateReferralCode();
      while (await User.exists({ referralCode: newCode })) {
        newCode = generateReferralCode();
      }

      user = await User.create({
        phone,
        name: safeName,
        isVerified: true,
        referralCode: newCode,
        referredBy,
      });

      // Reward both parties if referred
      if (referredBy) {
        const referrer = await User.findById(referredBy);
        if (referrer) {
          // Reward new user
          user.loyaltyPoints = (user.loyaltyPoints ?? 0) + REFERRAL_REWARD_POINTS;
          await user.save();
          await LoyaltyTransaction.create({
            userId: user._id,
            type: 'adjustment',
            points: REFERRAL_REWARD_POINTS,
            balanceAfter: user.loyaltyPoints,
            description: `Referral bonus — joined via ${referrer.name || referrer.phone}'s code`,
          });

          // Reward referrer
          referrer.loyaltyPoints = (referrer.loyaltyPoints ?? 0) + REFERRAL_REWARD_POINTS;
          referrer.referralCount = (referrer.referralCount ?? 0) + 1;
          await referrer.save();
          await LoyaltyTransaction.create({
            userId: referrer._id,
            type: 'adjustment',
            points: REFERRAL_REWARD_POINTS,
            balanceAfter: referrer.loyaltyPoints,
            description: `Referral bonus — ${safeName} joined using your code`,
          });
        }
      }
    } else {
      user.isVerified = true;
      await user.save();
    }

    const token = signToken({ id: user._id, role: 'user', phone: user.phone });
    res.json({
      success: true,
      token,
      user: { id: user._id, name: user.name, phone: user.phone, role: 'user' },
      ...(isNewUser && { referralCode: user.referralCode }),
    });
  }
);

// Rider Register
router.post('/rider/register',
  [body('name').trim().notEmpty(), body('phone').trim().isMobilePhone('any'),
   body('nationalId').trim().notEmpty(), body('vehicleType').isIn(['motorbike','tricycle','van']),
   body('vehiclePlate').trim().notEmpty()],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { name, phone, nationalId, vehicleType, vehiclePlate } = req.body;
    if (await Rider.findOne({ phone })) return res.status(409).json({ success: false, message: 'Phone already registered' });
    const rider = await Rider.create({ name, phone, nationalId, vehicleType, vehiclePlate });
    const code = await createOTP(phone, 'registration');
    if (process.env.NODE_ENV === 'development') return res.status(201).json({ success: true, riderId: rider._id, _devCode: code });
    await sendSMS(phone, SMS_TEMPLATES.otpVerification(code));
    res.status(201).json({ success: true, message: 'Registration submitted. Verify your phone.' });
  }
);

// Rider Send OTP
router.post('/rider/send-otp',
  [body('phone').trim().isMobilePhone('any')],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const rider = await Rider.findOne({ phone: req.body.phone });
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    const code = await createOTP(req.body.phone, 'login');
    if (process.env.NODE_ENV === 'development') return res.json({ success: true, _devCode: code });
    await sendSMS(req.body.phone, SMS_TEMPLATES.otpVerification(code));
    res.json({ success: true });
  }
);

// Rider Login
router.post('/rider/login',
  [body('phone').trim().isMobilePhone('any'), body('code').isLength({ min:4, max:6 })],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone, code } = req.body;
    try {
      await verifyOTP(phone, code, 'login');
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message || 'Invalid OTP' });
    }
    const rider = await Rider.findOne({ phone });
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    if (rider.kycStatus !== 'approved') return res.status(403).json({ success: false, message: 'KYC approval required' });
    const token = signToken({ id: rider._id, role: 'rider', phone });
    res.json({ success: true, token, rider: { id: rider._id, name: rider.name, phone, kycStatus: rider.kycStatus, status: rider.status } });
  }
);

// Admin Login
router.post('/admin/login',
  [body('phone').trim().notEmpty(), body('password').notEmpty()],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone, password } = req.body;
    const admin = await Admin.findOne({ $or: [{ phone }, { email: phone }], isActive: true });
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: admin._id, role: 'admin', phone: admin.phone }, '12h');
    res.json({ success: true, token, admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
  }
);

// Station Register
/**
 * @swagger
 * /api/v1/auth/station/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new station owner + station
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, phone, stationName, address, city, lat, lng]
 *             properties:
 *               name:        { type: string, example: Kofi Boateng }
 *               phone:       { type: string, example: '+233244123456' }
 *               stationName: { type: string, example: Kofi Gas Station }
 *               address:     { type: string, example: 45 Ring Road, Accra }
 *               city:        { type: string, example: Accra }
 *               lat:         { type: number, example: 5.6037 }
 *               lng:         { type: number, example: -0.1870 }
 *     responses:
 *       201:
 *         description: Registration submitted, OTP sent
 *       409:
 *         description: Phone already registered
 */
router.post('/station/register',
  [
    body('name').trim().notEmpty(),
    body('phone').trim().isMobilePhone('any'),
    body('stationName').trim().notEmpty(),
    body('address').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
  ],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { name, phone, stationName, address, city, lat, lng } = req.body;

    if (await User.findOne({ phone })) {
      return res.status(409).json({ success: false, message: 'Phone already registered' });
    }

    const { Station } = await import('../models/Station');
    const { encodeGeohash } = await import('../services/geoService');

    // Create owner user account
    const user = await User.create({ phone, name, isVerified: false });

    // Create station in pending state (admin must approve)
    await Station.create({
      ownerId: user._id,
      name: stationName,
      address,
      city,
      lat,
      lng,
      geohash: encodeGeohash(lat, lng, 7),
    });

    const code = await createOTP(phone, 'registration');
    if (process.env.NODE_ENV === 'development') {
      return res.status(201).json({ success: true, _devCode: code });
    }
    await sendSMS(phone, SMS_TEMPLATES.otpVerification(code));
    res.status(201).json({ success: true, message: 'Registration submitted. Verify your phone. Await admin approval.' });
  }
);

// Station Send OTP
router.post('/station/send-otp',
  [body('phone').trim().isMobilePhone('any')],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone } = req.body;

    // Verify a station owner account exists for this phone
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    const { Station } = await import('../models/Station');
    const station = await Station.findOne({ ownerId: user._id });
    if (!station) return res.status(404).json({ success: false, message: 'No station associated with this account' });

    const code = await createOTP(phone, 'login');
    if (process.env.NODE_ENV === 'development') return res.json({ success: true, _devCode: code });
    await sendSMS(phone, SMS_TEMPLATES.otpVerification(code));
    res.json({ success: true });
  }
);

// Station Verify OTP
router.post('/station/verify-otp',
  [body('phone').trim().isMobilePhone('any'), body('code').isLength({ min: 4, max: 6 }), body('purpose').isIn(['registration', 'login'])],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;
    const { phone, code, purpose } = req.body;
    try {
      await verifyOTP(phone, code, purpose);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message || 'Invalid OTP' });
    }

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

    const { Station } = await import('../models/Station');
    const station = await Station.findOne({ ownerId: user._id });
    if (!station) return res.status(403).json({ success: false, message: 'No station associated with this account' });

    if (station.status === 'pending') {
      return res.status(403).json({ success: false, message: 'Your station is pending admin approval' });
    }
    if (station.status === 'suspended' || station.status === 'banned') {
      return res.status(403).json({ success: false, message: `Station is ${station.status}` });
    }

    // Mark user as verified on first login
    if (!user.isVerified) {
      user.isVerified = true;
      await user.save();
    }

    const token = signToken({ id: user._id, role: 'station', stationId: station._id, phone });
    res.json({
      success: true,
      token,
      user: { id: user._id, name: user.name, phone },
      station: { id: station._id, name: station.name, status: station.status },
    });
  }
);

export default router;
