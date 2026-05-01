import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import { Order } from '../models/Order';
import { verifyPayment, initiateRefund } from '../services/paymentService';

const router = Router();

/**
 * @swagger
 * /api/v1/payments/webhook:
 *   post:
 *     tags: [Payments]
 *     summary: Paystack webhook (charge.success, transfer.success, transfer.failed)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook processed
 *       400:
 *         description: Invalid signature
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(rawBody)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).json({ success: false, message: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody.toString());
  const { event, data } = payload;

  if (event === 'charge.success') {
    const order = await Order.findOne({ paystackReference: data.reference });
    if (order && order.paymentStatus === 'pending') {
      order.paymentStatus = 'captured';
      await order.save();
    }
  }

  if (event === 'transfer.success') {
    // Mark station payout as settled using transfer reference stored in order
    await Order.findOneAndUpdate(
      { paystackReference: data.reference, paymentStatus: 'released' },
      { paymentStatus: 'released' } // already released; log if needed
    );
  }

  if (event === 'transfer.failed' || event === 'transfer.reversed') {
    console.error(`[Webhook] Payout ${event} for reference ${data.reference}`);
    // TODO: alert admin and retry payout
  }

  res.json({ status: 'ok' });
});

/**
 * @swagger
 * /api/v1/payments/verify/{reference}:
 *   get:
 *     tags: [Payments]
 *     summary: Verify a Paystack payment by reference
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payment verification result
 */
router.get('/verify/:reference', async (req: Request, res: Response) => {
  const result = await verifyPayment(req.params.reference);
  res.json({ success: true, payment: result });
});

export default router;
