import { Router, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { User } from '../models/User';
import { LoyaltyTransaction } from '../models/LoyaltyTransaction';
import { authenticate, AuthRequest } from '../middleware/authenticate';

const router = Router();
router.use(authenticate);

function ve(req: any, res: Response): boolean {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ success: false, errors: e.array() }); return true; }
  return false;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get current user profile
 *     responses:
 *       200:
 *         description: User profile
 *   patch:
 *     tags: [Users]
 *     summary: Update name, email or FCM token
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:     { type: string }
 *               email:    { type: string, format: email }
 *               fcmToken: { type: string }
 *     responses:
 *       200:
 *         description: Updated user
 */
router.get('/me', async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.user!.id).select('-passwordHash');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

/** PATCH /api/v1/users/me */
router.patch(
  '/me',
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('email').optional().isEmail().normalizeEmail(),
    body('fcmToken').optional().isString(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const { name, email, fcmToken } = req.body;
    const update: Record<string, unknown> = {};
    if (name)     update.name     = name;
    if (email)    update.email    = email;
    if (fcmToken) update.fcmToken = fcmToken;

    const user = await User.findByIdAndUpdate(req.user!.id, update, { new: true }).select('-passwordHash');
    res.json({ success: true, user });
  }
);

// ─── Saved Addresses ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/users/addresses:
 *   post:
 *     tags: [Users]
 *     summary: Add a saved delivery address
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [label, street, city, lat, lng]
 *             properties:
 *               label:     { type: string, example: Home }
 *               street:    { type: string }
 *               city:      { type: string }
 *               lat:       { type: number }
 *               lng:       { type: number }
 *               isDefault: { type: boolean }
 *     responses:
 *       201:
 *         description: Address added
 */
router.post(
  '/addresses',
  [
    body('label').trim().notEmpty(),
    body('street').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('isDefault').optional().isBoolean(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { label, street, city, lat, lng, isDefault } = req.body;
    if (isDefault) user.savedAddresses.forEach((a) => (a.isDefault = false));
    user.savedAddresses.push({ label, street, city, lat, lng, isDefault: isDefault || false });
    await user.save();
    res.status(201).json({ success: true, addresses: user.savedAddresses });
  }
);

/**
 * @swagger
 * /api/v1/users/addresses/{addressId}:
 *   patch:
 *     tags: [Users]
 *     summary: Update or set a saved address as default
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated addresses
 *   delete:
 *     tags: [Users]
 *     summary: Delete a saved address
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Address deleted
 */
router.patch(
  '/addresses/:addressId',
  [param('addressId').isMongoId()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const address = (user.savedAddresses as any).id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found' });

    const { label, street, city, lat, lng, isDefault } = req.body;
    if (isDefault) user.savedAddresses.forEach((a) => (a.isDefault = false));
    if (label  !== undefined) address.label  = label;
    if (street !== undefined) address.street = street;
    if (city   !== undefined) address.city   = city;
    if (lat    !== undefined) address.lat    = lat;
    if (lng    !== undefined) address.lng    = lng;
    if (isDefault !== undefined) address.isDefault = isDefault;

    await user.save();
    res.json({ success: true, addresses: user.savedAddresses });
  }
);

/** DELETE /api/v1/users/addresses/:addressId */
router.delete(
  '/addresses/:addressId',
  [param('addressId').isMongoId()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const address = (user.savedAddresses as any).id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found' });

    address.deleteOne();
    await user.save();
    res.json({ success: true, addresses: user.savedAddresses });
  }
);

// ─── Payment Methods ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/users/payment-methods:
 *   post:
 *     tags: [Users]
 *     summary: Add a payment method
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type]
 *             properties:
 *               type:          { type: string, enum: [mobile_money, card, cash] }
 *               provider:      { type: string, example: mtn }
 *               accountNumber: { type: string }
 *               last4:         { type: string }
 *               isDefault:     { type: boolean }
 *     responses:
 *       201:
 *         description: Payment method added
 */
router.post(
  '/payment-methods',
  [
    body('type').isIn(['mobile_money', 'card', 'cash']),
    body('provider').optional().trim().notEmpty(),
    body('accountNumber').optional().trim().notEmpty(),
    body('last4').optional().isLength({ min: 4, max: 4 }),
    body('isDefault').optional().isBoolean(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { type, provider, accountNumber, last4, isDefault } = req.body;
    if (isDefault) user.paymentMethods.forEach((p) => (p.isDefault = false));
    user.paymentMethods.push({ type, provider, accountNumber, last4, isDefault: isDefault || false });
    await user.save();
    res.status(201).json({ success: true, paymentMethods: user.paymentMethods });
  }
);

/**
 * @swagger
 * /api/v1/users/payment-methods/{methodId}:
 *   patch:
 *     tags: [Users]
 *     summary: Set a payment method as default
 *     parameters:
 *       - in: path
 *         name: methodId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated payment methods
 *   delete:
 *     tags: [Users]
 *     summary: Delete a payment method
 *     parameters:
 *       - in: path
 *         name: methodId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payment method deleted
 */
router.patch(
  '/payment-methods/:methodId',
  [param('methodId').isMongoId(), body('isDefault').optional().isBoolean()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const method = (user.paymentMethods as any).id(req.params.methodId);
    if (!method) return res.status(404).json({ success: false, message: 'Payment method not found' });

    if (req.body.isDefault) {
      user.paymentMethods.forEach((p) => (p.isDefault = false));
      method.isDefault = true;
    }

    await user.save();
    res.json({ success: true, paymentMethods: user.paymentMethods });
  }
);

/** DELETE /api/v1/users/payment-methods/:methodId */
router.delete(
  '/payment-methods/:methodId',
  [param('methodId').isMongoId()],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const method = (user.paymentMethods as any).id(req.params.methodId);
    if (!method) return res.status(404).json({ success: false, message: 'Payment method not found' });

    method.deleteOne();
    await user.save();
    res.json({ success: true, paymentMethods: user.paymentMethods });
  }
);

// ─── Referral ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/users/referral:
 *   get:
 *     tags: [Users]
 *     summary: Get referral code, count and share URL
 *     responses:
 *       200:
 *         description: Referral info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 referralCode:  { type: string }
 *                 referralCount: { type: integer }
 *                 pointsBalance: { type: integer }
 *                 shareUrl:      { type: string }
 */
router.get('/referral', async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.user!.id).select('referralCode referralCount loyaltyPoints');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // Lazy-generate referral code if missing (existing users pre-feature)
  if (!user.referralCode) {
    const crypto = await import('crypto');
    let code = crypto.randomBytes(4).toString('hex').toUpperCase();
    while (await User.exists({ referralCode: code })) {
      code = crypto.randomBytes(4).toString('hex').toUpperCase();
    }
    user.referralCode = code;
    await user.save();
  }

  res.json({
    success: true,
    referralCode: user.referralCode,
    referralCount: user.referralCount,
    pointsBalance: user.loyaltyPoints,
    shareUrl: `${process.env.FRONTEND_URL || 'https://gasgo.app'}/?ref=${user.referralCode}`,
  });
});

// ─── Loyalty ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/users/loyalty:
 *   get:
 *     tags: [Users]
 *     summary: Get loyalty points balance and transaction history
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Balance and transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:      { type: integer }
 *                 transactions: { type: array, items: { type: object } }
 *                 pagination:   { $ref: '#/components/schemas/Pagination' }
 */
router.get('/loyalty', async (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string || '1');
  const limit = parseInt(req.query.limit as string || '20');
  const skip  = (page - 1) * limit;

  const user = await User.findById(req.user!.id).select('loyaltyPoints');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const [transactions, total] = await Promise.all([
    LoyaltyTransaction.find({ userId: req.user!.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('orderId', 'cylinders orderType createdAt'),
    LoyaltyTransaction.countDocuments({ userId: req.user!.id }),
  ]);

  res.json({
    success: true,
    balance: user.loyaltyPoints,
    transactions,
    pagination: { page, limit, total },
  });
});

export default router;
