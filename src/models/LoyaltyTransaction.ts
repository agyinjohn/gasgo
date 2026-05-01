import mongoose, { Document, Schema } from 'mongoose';

export interface ILoyaltyTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId;
  type: 'earn' | 'redeem' | 'expire' | 'adjustment';
  points: number;           // positive = earn, negative = redeem/expire
  balanceAfter: number;     // snapshot of balance after this transaction
  description: string;
  createdAt: Date;
}

const LoyaltyTransactionSchema = new Schema<ILoyaltyTransaction>(
  {
    userId:       { type: Schema.Types.ObjectId, required: true, ref: 'User', index: true },
    orderId:      { type: Schema.Types.ObjectId, ref: 'Order', sparse: true },
    type:         { type: String, enum: ['earn', 'redeem', 'expire', 'adjustment'], required: true },
    points:       { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    description:  { type: String, required: true },
  },
  { timestamps: true }
);

LoyaltyTransactionSchema.index({ userId: 1, createdAt: -1 });

export const LoyaltyTransaction = mongoose.model<ILoyaltyTransaction>('LoyaltyTransaction', LoyaltyTransactionSchema);

// ─── Config ───────────────────────────────────────────────────────────────────
// 1 point earned per GHS 1 spent (rounded down)
// 100 points = GHS 1 discount
export const LOYALTY_EARN_RATE  = 1;    // points per GHS
export const LOYALTY_REDEEM_RATE = 100; // points per GHS discount
export const LOYALTY_MIN_REDEEM  = 100; // minimum points to redeem
