import mongoose, { Document, Schema } from 'mongoose';

export interface IPayout extends Document {
  _id: mongoose.Types.ObjectId;
  recipientType: 'rider' | 'station';
  recipientId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  amountGHS: number;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  paystackTransferCode?: string;
  paystackReference?: string;
  failureReason?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PayoutSchema = new Schema<IPayout>(
  {
    recipientType: { type: String, enum: ['rider', 'station'], required: true },
    recipientId:   { type: Schema.Types.ObjectId, required: true, index: true },
    orderId:       { type: Schema.Types.ObjectId, required: true, ref: 'Order', index: true },
    amountGHS:     { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'failed'],
      default: 'pending',
      index: true,
    },
    paystackTransferCode: String,
    paystackReference:    { type: String, sparse: true, index: true },
    failureReason:        String,
    paidAt:               Date,
  },
  { timestamps: true }
);

PayoutSchema.index({ recipientId: 1, createdAt: -1 });
PayoutSchema.index({ status: 1, createdAt: -1 });

export const Payout = mongoose.model<IPayout>('Payout', PayoutSchema);
