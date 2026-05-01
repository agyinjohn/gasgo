import mongoose, { Document, Schema } from 'mongoose';

interface IOperatingHours {
  open: string;   // "08:00"
  close: string;  // "18:00"
  isOpen: boolean;
}

interface IDayHours {
  mon: IOperatingHours;
  tue: IOperatingHours;
  wed: IOperatingHours;
  thu: IOperatingHours;
  fri: IOperatingHours;
  sat: IOperatingHours;
  sun: IOperatingHours;
}

export interface ICylinderListing {
  size: 3 | 6 | 12;
  brand: string;
  fillType: string;
  fillPrice: number;
  exchangePrice: number;
  stockCount: number;
  needsRefillCount: number;  // returned empties awaiting refill
  lowStockThreshold: number;
  isPaused: boolean;         // manually paused by station owner
  isAvailable: boolean;      // computed: stockCount > 0 && !isPaused
}

export interface IStation extends Document {
  _id: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;   // references Admin or StationOwner user
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  geohash: string;                    // level-7 geohash for proximity queries
  operatingHours: IDayHours;
  status: 'pending' | 'active' | 'suspended' | 'banned';
  commissionPct: number;              // platform commission for this station
  ratingAvg: number;
  totalRatings: number;
  totalOrders: number;
  cylinderListings: ICylinderListing[];
  bankAccount?: {
    provider: string;                 // mobile money provider or bank name
    accountNumber: string;
    accountName: string;
  };
  fcmToken?: string;
  priceChangeLog: Array<{
    size: number;
    oldFillPrice: number;
    newFillPrice: number;
    oldExchangePrice: number;
    newExchangePrice: number;
    changedAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const OperatingHoursSchema = new Schema<IOperatingHours>({
  open: { type: String, default: '08:00' },
  close: { type: String, default: '18:00' },
  isOpen: { type: Boolean, default: true },
}, { _id: false });

const CylinderListingSchema = new Schema<ICylinderListing>({
  size: { type: Number, enum: [3, 6, 12], required: true },
  brand: { type: String, required: true, trim: true },
  fillType: { type: String, default: 'LPG' },
  fillPrice: { type: Number, required: true, min: 0 },
  exchangePrice: { type: Number, required: true, min: 0 },
  stockCount: { type: Number, default: 0, min: 0 },
  needsRefillCount: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 5 },
  isPaused: { type: Boolean, default: false },
  isAvailable: { type: Boolean, default: true },
}, { _id: false });

// Enforce exchangePrice <= fillPrice at schema level
CylinderListingSchema.pre('validate', function () {
  if (this.exchangePrice > this.fillPrice) {
    this.invalidate('exchangePrice', 'Exchange price must be less than or equal to fill price');
  }
});

const StationSchema = new Schema<IStation>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    geohash: { type: String, required: true, index: true },
    operatingHours: {
      mon: { type: OperatingHoursSchema, default: {} },
      tue: { type: OperatingHoursSchema, default: {} },
      wed: { type: OperatingHoursSchema, default: {} },
      thu: { type: OperatingHoursSchema, default: {} },
      fri: { type: OperatingHoursSchema, default: {} },
      sat: { type: OperatingHoursSchema, default: {} },
      sun: { type: OperatingHoursSchema, default: { isOpen: false } },
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'suspended', 'banned'],
      default: 'pending',
    },
    commissionPct: { type: Number, default: 10, min: 0, max: 100 },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    totalRatings: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    cylinderListings: [CylinderListingSchema],
    bankAccount: {
      provider: String,
      accountNumber: String,
      accountName: String,
    },
    fcmToken: String,
    priceChangeLog: [
      {
        size: Number,
        oldFillPrice: Number,
        newFillPrice: Number,
        oldExchangePrice: Number,
        newExchangePrice: Number,
        changedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// 2dsphere index for geospatial queries
StationSchema.index({ lat: 1, lng: 1 });
StationSchema.index({ status: 1 });
StationSchema.index({ city: 1, status: 1 });

export const Station = mongoose.model<IStation>('Station', StationSchema);
