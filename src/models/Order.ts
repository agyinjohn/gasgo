import mongoose, { Document, Schema } from 'mongoose';

export interface IDispatchAttempt {
  riderId: mongoose.Types.ObjectId;
  sentAt: Date;
  outcome: 'accepted' | 'declined' | 'timeout';
}

export interface IStatusEvent {
  status: string;
  triggeredBy: 'user' | 'rider' | 'station' | 'admin' | 'system';
  triggeredById?: mongoose.Types.ObjectId;
  timestamp: Date;
  note?: string;
}

export interface ICylinderLineItem {
  size: 3 | 6 | 12;
  quantity: number;
  unitPrice: number;    // price per cylinder at time of order
  subtotal: number;     // unitPrice * quantity
}

export interface IOrder extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  stationId: mongoose.Types.ObjectId;
  riderId?: mongoose.Types.ObjectId;

  // Cylinder line items (multi-cylinder support)
  cylinders: ICylinderLineItem[];
  orderType: 'fill' | 'delivery' | 'exchange';

  // Pricing snapshot (immutable after creation)
  cylinderSubtotal: number;       // sum of all line item subtotals
  deliveryFee: number;            // scaled by total cylinder count
  totalAmount: number;            // cylinderSubtotal + deliveryFee
  commissionPct: number;
  commissionAmount: number;
  stationPayout: number;
  surgeMultiplier: number;

  // Loyalty
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscount: number;         // GHS discount applied from points

  // Status
  status: 'scheduled' | 'pending' | 'accepted' | 'at_station' | 'en_route' | 'delivered' | 'cancelled';
  statusHistory: IStatusEvent[];

  // Delivery
  deliveryAddress: {
    street: string;
    city: string;
    lat: number;
    lng: number;
  };

  // OTP confirmation
  otpCode: string;
  otpExpiresAt: Date;
  otpAttempts: number;
  otpVerifiedAt?: Date;

  // Payment
  paymentMethod: 'mobile_money' | 'card' | 'cash';
  paymentProvider?: string;        // MTN, Vodafone, etc.
  paystackReference?: string;
  paymentStatus: 'pending' | 'captured' | 'released' | 'refunded';

  // Rating — rider
  riderRating?: number;
  riderRatingComment?: string;
  ratedAt?: Date;

  // Rating — station
  stationRating?: number;
  stationRatingComment?: string;
  stationRatedAt?: Date;

  // Dispatch tracking
  dispatchAttempts: IDispatchAttempt[];

  // Delivery photo
  deliveryPhotoUrl?: string;

  // Exchange-specific
  exchangeOldSize?: 3 | 6 | 12;

  // Cancellation
  cancellationReason?: string;
  cancelledBy?: 'user' | 'station' | 'admin' | 'system';

  // Scheduled delivery
  isScheduled: boolean;
  scheduledFor?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const StatusEventSchema = new Schema<IStatusEvent>({
  status: { type: String, required: true },
  triggeredBy: {
    type: String,
    enum: ['user', 'rider', 'station', 'admin', 'system'],
    required: true,
  },
  triggeredById: Schema.Types.ObjectId,
  timestamp: { type: Date, default: Date.now },
  note: String,
}, { _id: false });

const DispatchAttemptSchema = new Schema<IDispatchAttempt>({
  riderId: { type: Schema.Types.ObjectId, required: true, ref: 'Rider' },
  sentAt: { type: Date, default: Date.now },
  outcome: { type: String, enum: ['accepted', 'declined', 'timeout'] },
}, { _id: false });

const CylinderLineItemSchema = new Schema<ICylinderLineItem>({
  size:      { type: Number, enum: [3, 6, 12], required: true },
  quantity:  { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  subtotal:  { type: Number, required: true, min: 0 },
}, { _id: false });

const OrderSchema = new Schema<IOrder>(
  {
    userId:    { type: Schema.Types.ObjectId, required: true, ref: 'User',    index: true },
    stationId: { type: Schema.Types.ObjectId, required: true, ref: 'Station', index: true },
    riderId:   { type: Schema.Types.ObjectId, ref: 'Rider', index: true },

    cylinders: { type: [CylinderLineItemSchema], required: true },
    orderType: { type: String, enum: ['fill', 'delivery', 'exchange'], required: true },

    cylinderSubtotal:  { type: Number, required: true, min: 0 },
    deliveryFee:       { type: Number, required: true, min: 0 },
    totalAmount:       { type: Number, required: true, min: 0 },
    commissionPct:     { type: Number, required: true },
    commissionAmount:  { type: Number, required: true },
    stationPayout:     { type: Number, required: true },
    surgeMultiplier:   { type: Number, default: 1 },
    loyaltyPointsEarned:   { type: Number, default: 0 },
    loyaltyPointsRedeemed: { type: Number, default: 0 },
    loyaltyDiscount:       { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['scheduled', 'pending', 'accepted', 'at_station', 'en_route', 'delivered', 'cancelled'],
      default: 'pending',
      index: true,
    },
    statusHistory: [StatusEventSchema],

    deliveryAddress: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },

    otpCode: { type: String, required: true },
    otpExpiresAt: { type: Date, required: true },
    otpAttempts: { type: Number, default: 0 },
    otpVerifiedAt: Date,

    paymentMethod: {
      type: String,
      enum: ['mobile_money', 'card', 'cash'],
      required: true,
    },
    paymentProvider: String,
    paystackReference: { type: String, index: true, sparse: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'captured', 'released', 'refunded'],
      default: 'pending',
    },

    riderRating: { type: Number, min: 1, max: 5 },
    riderRatingComment: String,
    ratedAt: Date,

    stationRating: { type: Number, min: 1, max: 5 },
    stationRatingComment: String,
    stationRatedAt: Date,

    dispatchAttempts: [DispatchAttemptSchema],
    deliveryPhotoUrl: String,
    exchangeOldSize: { type: Number, enum: [3, 6, 12] },
    cancellationReason: String,
    cancelledBy: { type: String, enum: ['user', 'station', 'admin', 'system'] },
    isScheduled: { type: Boolean, default: false },
    scheduledFor: { type: Date, index: true, sparse: true },
  },
  {
    timestamps: true,
    // Keep order records for 5 years (regulatory) — enforce via MongoDB TTL or backup policy
  }
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ stationId: 1, createdAt: -1 });
OrderSchema.index({ riderId: 1, status: 1 });
OrderSchema.index({ isScheduled: 1, scheduledFor: 1, status: 1 }); // for cron pickup

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
