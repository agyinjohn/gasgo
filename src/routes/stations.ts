import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Station } from '../models/Station';
import { Order } from '../models/Order';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { getNearbyStations, encodeGeohash } from '../services/geoService';

const router = Router();

function ve(req: Request, res: Response): boolean {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ success: false, errors: e.array() }); return true; }
  return false;
}

// ─── Public — Station Discovery ───────────────────────────────────────────────

/** GET /api/v1/stations/pricing — public active pricing config (surge banner) */
/**
 * @swagger
 * /api/v1/stations/pricing:
 *   get:
 *     tags: [Stations]
 *     summary: Get current platform pricing config (surge, delivery fee)
 *     security: []
 *     responses:
 *       200:
 *         description: Pricing config
 */
router.get('/pricing', async (_req: Request, res: Response) => {
  const { PricingConfig } = await import('../models/PricingConfig');
  const config = await PricingConfig.findOne()
    .sort({ createdAt: -1 })
    .select('deliveryFeeFlat surgeActive surgeMultiplier surgeReason priceFreezeActive');
  res.json({
    success: true,
    pricing: config || { deliveryFeeFlat: 5, surgeActive: false, surgeMultiplier: 1, priceFreezeActive: false },
  });
});

/**
 * @swagger
 * /api/v1/stations/nearby:
 *   get:
 *     tags: [Stations]
 *     summary: Find nearby stations by GPS coordinates
 *     security: []
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: lng
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: radius
 *         schema: { type: number, default: 10 }
 *       - in: query
 *         name: size
 *         schema: { type: integer, enum: [3, 6, 12] }
 *     responses:
 *       200:
 *         description: List of nearby stations sorted by distance
 */
router.get(
  '/nearby',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('radius').optional().isFloat({ min: 1, max: 25 }),
    query('size').optional().isIn(['3', '6', '12']),
  ],
  async (req: Request, res: Response) => {
    if (ve(req, res)) return;

    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radiusKm = parseFloat(req.query.radius as string || '10');
    const cylinderSize = req.query.size ? (parseInt(req.query.size as string) as 3 | 6 | 12) : undefined;

    const results = await getNearbyStations({ lat, lng, radiusKm, cylinderSize, limit: 20 });

    res.json({
      success: true,
      stations: results.map(({ station, distanceKm }) => ({
        id: station._id,
        name: station.name,
        address: station.address,
        lat: station.lat,
        lng: station.lng,
        distanceKm: Math.round(distanceKm * 10) / 10,
        ratingAvg: station.ratingAvg,
        cylinderListings: station.cylinderListings.filter((l) => l.isAvailable && l.stockCount > 0),
      })),
    });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}:
 *   get:
 *     tags: [Stations]
 *     summary: Get station detail
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Station detail
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Station'
 *       404:
 *         description: Station not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  const station = await Station.findById(req.params.id).select(
    'name address city lat lng ratingAvg totalRatings totalOrders status operatingHours cylinderListings commissionPct'
  );
  if (!station || station.status !== 'active') {
    return res.status(404).json({ success: false, message: 'Station not found' });
  }
  res.json({ success: true, station });
});

/**
 * @swagger
 * /api/v1/stations/{id}/reviews:
 *   get:
 *     tags: [Stations]
 *     summary: Get paginated reviews for a station
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated reviews
 */
router.get('/:id/reviews', async (req: Request, res: Response) => {
  const stationId = new mongoose.Types.ObjectId(req.params.id);
  const page  = parseInt(req.query.page  as string || '1');
  const limit = parseInt(req.query.limit as string || '10');
  const skip  = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    Order.find(
      { stationId, stationRating: { $exists: true } },
      'stationRating stationRatingComment stationRatedAt userId cylinders orderType'
    )
      .sort({ stationRatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name'),
    Order.countDocuments({ stationId, stationRating: { $exists: true } }),
  ]);

  res.json({ success: true, reviews, pagination: { page, limit, total } });
});

// ─── Authenticated Station Routes ─────────────────────────────────────────────

router.use(authenticate);

/**
 * @swagger
 * /api/v1/stations:
 *   post:
 *     tags: [Stations]
 *     summary: Register a new station (station owner)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, address, city, lat, lng]
 *             properties:
 *               name:    { type: string }
 *               address: { type: string }
 *               city:    { type: string }
 *               lat:     { type: number }
 *               lng:     { type: number }
 *     responses:
 *       201:
 *         description: Station created (pending approval)
 */
router.post(
  '/',
  [
    body('name').trim().notEmpty(),
    body('address').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const { name, address, city, lat, lng } = req.body;
    const geohash = encodeGeohash(lat, lng, 7);

    const station = await Station.create({
      ownerId: req.user!.id,
      name,
      address,
      city,
      lat,
      lng,
      geohash,
    });

    res.status(201).json({ success: true, station });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/prices:
 *   patch:
 *     tags: [Stations]
 *     summary: Update cylinder prices for a size
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
 *             required: [size, fillPrice, exchangePrice]
 *             properties:
 *               size:          { type: integer, enum: [3, 6, 12] }
 *               fillPrice:     { type: number }
 *               exchangePrice: { type: number }
 *     responses:
 *       200:
 *         description: Updated listing
 *       400:
 *         description: Exchange price exceeds fill price
 */
router.patch(
  '/:id/prices',
  [
    body('size').isIn([3, 6, 12]),
    body('fillPrice').isFloat({ min: 0 }),
    body('exchangePrice').isFloat({ min: 0 }),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });

    const { size, fillPrice, exchangePrice } = req.body;

    if (exchangePrice > fillPrice) {
      return res.status(400).json({ success: false, message: 'Exchange price must be ≤ fill price' });
    }

    const listing = station.cylinderListings.find((l) => l.size === size);
    if (!listing) return res.status(404).json({ success: false, message: 'Cylinder listing not found' });

    // Log price change
    station.priceChangeLog.push({
      size,
      oldFillPrice: listing.fillPrice,
      newFillPrice: fillPrice,
      oldExchangePrice: listing.exchangePrice,
      newExchangePrice: exchangePrice,
      changedAt: new Date(),
    });

    listing.fillPrice = fillPrice;
    listing.exchangePrice = exchangePrice;
    await station.save();

    res.json({ success: true, listing });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/inventory:
 *   patch:
 *     tags: [Stations]
 *     summary: Update stock count, pause/unpause, or set low stock threshold
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
 *             required: [size]
 *             properties:
 *               size:              { type: integer, enum: [3, 6, 12] }
 *               stockCount:        { type: integer, minimum: 0 }
 *               isPaused:          { type: boolean }
 *               lowStockThreshold: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: Updated listing
 */
router.patch(
  '/:id/inventory',
  [
    body('size').isIn([3, 6, 12]),
    body('stockCount').optional().isInt({ min: 0 }),
    body('isPaused').optional().isBoolean(),
    body('lowStockThreshold').optional().isInt({ min: 0 }),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });

    const { size, stockCount, isPaused, lowStockThreshold } = req.body;
    const listing = station.cylinderListings.find((l) => l.size === size);
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

    if (stockCount !== undefined) listing.stockCount = stockCount;
    if (isPaused  !== undefined) listing.isPaused   = isPaused;
    if (lowStockThreshold !== undefined) listing.lowStockThreshold = lowStockThreshold;

    // isAvailable = has stock AND not manually paused
    listing.isAvailable = listing.stockCount > 0 && !listing.isPaused;

    await station.save();
    res.json({ success: true, listing });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/exchange-returns:
 *   post:
 *     tags: [Stations]
 *     summary: Log returned empty cylinders (increments needsRefillCount)
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
 *             required: [size]
 *             properties:
 *               size:     { type: integer, enum: [3, 6, 12] }
 *               quantity: { type: integer, minimum: 1, default: 1 }
 *     responses:
 *       200:
 *         description: Updated listing
 */
router.post(
  '/:id/exchange-returns',
  [body('size').isIn([3, 6, 12]), body('quantity').optional().isInt({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });

    const { size, quantity = 1 } = req.body;
    const listing = station.cylinderListings.find((l) => l.size === size);
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

    listing.needsRefillCount += quantity;
    await station.save();

    res.json({ success: true, listing });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/refill-complete:
 *   patch:
 *     tags: [Stations]
 *     summary: Mark cylinders as refilled (moves needsRefillCount to stockCount)
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
 *             required: [size]
 *             properties:
 *               size:     { type: integer, enum: [3, 6, 12] }
 *               quantity: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Updated listing
 */
router.patch(
  '/:id/refill-complete',
  [body('size').isIn([3, 6, 12]), body('quantity').optional().isInt({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });

    const { size, quantity } = req.body;
    const listing = station.cylinderListings.find((l) => l.size === size);
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

    const qty = quantity ?? listing.needsRefillCount;
    const toMove = Math.min(qty, listing.needsRefillCount);

    listing.needsRefillCount = Math.max(0, listing.needsRefillCount - toMove);
    listing.stockCount += toMove;
    listing.isAvailable = listing.stockCount > 0 && !listing.isPaused;

    await station.save();
    res.json({ success: true, listing });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/orders:
 *   get:
 *     tags: [Stations]
 *     summary: Get station order queue
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Comma-separated statuses e.g. pending,accepted
 *     responses:
 *       200:
 *         description: List of orders
 */
router.get('/:id/orders', async (req: AuthRequest, res: Response) => {
  const stationId = new mongoose.Types.ObjectId(req.params.id);
  const { status } = req.query as Record<string, string>;

  const filter: Record<string, unknown> = { stationId };
  if (status) {
    // Support comma-separated statuses e.g. ?status=pending,accepted
    filter.status = { $in: status.split(',').map((s) => s.trim()) };
  }

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('userId', 'name phone')
    .populate('riderId', 'name phone vehicleType');

  res.json({ success: true, orders });
});

/**
 * @swagger
 * /api/v1/stations/{id}/settings:
 *   patch:
 *     tags: [Stations]
 *     summary: Update operating hours and bank account
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               operatingHours: { type: object }
 *               bankAccount:
 *                 type: object
 *                 properties:
 *                   provider:      { type: string }
 *                   accountNumber: { type: string }
 *                   accountName:   { type: string }
 *     responses:
 *       200:
 *         description: Updated station
 *       403:
 *         description: Forbidden
 */
router.patch(
  '/:id/settings',
  [
    body('operatingHours').optional().isObject(),
    body('bankAccount.provider').optional().trim().notEmpty(),
    body('bankAccount.accountNumber').optional().trim().notEmpty(),
    body('bankAccount.accountName').optional().trim().notEmpty(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (ve(req, res)) return;

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ success: false, message: 'Station not found' });

    // Only the owner can update settings
    if (station.ownerId.toString() !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { operatingHours, bankAccount } = req.body;

    if (operatingHours) {
      const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
      for (const day of days) {
        if (operatingHours[day]) {
          station.operatingHours[day] = {
            ...station.operatingHours[day],
            ...operatingHours[day],
          };
        }
      }
    }

    if (bankAccount) {
      station.bankAccount = bankAccount;
    }

    await station.save();
    res.json({ success: true, station });
  }
);

/**
 * @swagger
 * /api/v1/stations/{id}/analytics:
 *   get:
 *     tags: [Stations]
 *     summary: Get station analytics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: [day, week, month], default: week }
 *     responses:
 *       200:
 *         description: Analytics data including daily chart, size split, order type split, avg delivery time
 */
router.get('/:id/analytics', async (req: AuthRequest, res: Response) => {
  const stationId = new mongoose.Types.ObjectId(req.params.id);
  const period = (req.query.period as string) || 'week';

  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);

  const periodStart = new Date(now);
  if (period === 'day')   periodStart.setHours(0, 0, 0, 0);
  if (period === 'week')  periodStart.setDate(now.getDate() - 7);
  if (period === 'month') periodStart.setDate(now.getDate() - 30);

  const matchDelivered = { stationId, status: 'delivered', createdAt: { $gte: periodStart } };
  const matchToday     = { stationId, status: 'delivered', createdAt: { $gte: startOfDay } };

  const [
    todaySummary,
    periodSummary,
    dailyChart,
    orderTypeSplit,
    sizeSplit,
    avgDeliveryTime,
    exchangeQueue,
  ] = await Promise.all([

    // Today totals
    Order.aggregate([
      { $match: matchToday },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$stationPayout' }, commission: { $sum: '$commissionAmount' } } },
    ]),

    // Period totals
    Order.aggregate([
      { $match: matchDelivered },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$stationPayout' }, commission: { $sum: '$commissionAmount' }, gmv: { $sum: '$totalAmount' } } },
    ]),

    // Daily chart — orders + revenue per day
    Order.aggregate([
      { $match: matchDelivered },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
          revenue: { $sum: '$stationPayout' },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Order type split: delivery vs exchange
    Order.aggregate([
      { $match: matchDelivered },
      { $group: { _id: '$orderType', count: { $sum: 1 }, revenue: { $sum: '$stationPayout' } } },
    ]),

    // Cylinder size breakdown (unwind line items)
    Order.aggregate([
      { $match: matchDelivered },
      { $unwind: '$cylinders' },
      { $group: { _id: '$cylinders.size', count: { $sum: '$cylinders.quantity' }, revenue: { $sum: '$cylinders.subtotal' } } },
      { $sort: { count: -1 } },
    ]),

    // Average delivery time: order created → delivered (in minutes)
    Order.aggregate([
      { $match: matchDelivered },
      {
        $project: {
          deliveryMinutes: {
            $divide: [
              { $subtract: ['$updatedAt', '$createdAt'] },
              60000, // ms → minutes
            ],
          },
        },
      },
      { $group: { _id: null, avgMinutes: { $avg: '$deliveryMinutes' } } },
    ]),

    // Exchange queue — cylinders awaiting refill per size
    Station.findById(stationId, 'cylinderListings').lean(),
  ]);

  // Build exchange queue from station listings
  const refillQueue = (exchangeQueue as any)?.cylinderListings
    ?.filter((l: any) => l.needsRefillCount > 0)
    .map((l: any) => ({ size: l.size, needsRefillCount: l.needsRefillCount })) ?? [];

  res.json({
    success: true,
    analytics: {
      today: todaySummary[0]  || { count: 0, revenue: 0, commission: 0 },
      period: periodSummary[0] || { count: 0, revenue: 0, commission: 0, gmv: 0 },
      dailyChart,
      orderTypeSplit,
      sizeSplit,
      avgDeliveryMinutes: avgDeliveryTime[0]?.avgMinutes
        ? +avgDeliveryTime[0].avgMinutes.toFixed(1)
        : null,
      refillQueue,
    },
  });
});

export default router;
