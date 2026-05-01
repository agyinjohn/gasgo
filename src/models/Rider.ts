import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IRider extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  passwordHash?: string;
  nationalId: string;
  vehicleType: 'motorbike' | 'tricycle' | 'van';
  vehiclePlate: string;
  profilePhoto?: string;
  kycDocumentUrl?: string;
  kycStatus: 'pending' | 'approved' | 'rejected';
  kycRejectionReason?: string;
  status: 'offline' | 'available' | 'busy' | 'on_break';
  location?: {
    lat: number;
    lng: number;
    updatedAt: Date;
  };
  assignedZone?: string;
  currentOrderId?: mongoose.Types.ObjectId;
  fcmToken?: string;
  // Earnings & stats
  totalTrips: number;
  ratingAvg: number;
  totalRatings: number;
  totalEarnings: number;
  bankAccount?: {
    provider: string;
    accountNumber: string;
    accountName: string;
    recipientCode?: string;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(plain: string): Promise<boolean>;
}

const RiderSchema = new Schema<IRider>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    passwordHash: String,
    nationalId: { type: String, required: true, trim: true },
    vehicleType: {
      type: String,
      enum: ['motorbike', 'tricycle', 'van'],
      required: true,
    },
    vehiclePlate: { type: String, required: true, trim: true, uppercase: true },
    profilePhoto: String,
    kycDocumentUrl: String,
    kycStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    kycRejectionReason: String,
    status: {
      type: String,
      enum: ['offline', 'available', 'busy', 'on_break'],
      default: 'offline',
    },
    location: {
      lat: Number,
      lng: Number,
      updatedAt: Date,
    },
    assignedZone: String,
    currentOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    fcmToken: String,
    totalTrips: { type: Number, default: 0 },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    totalRatings: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    bankAccount: {
      provider: String,
      accountNumber: String,
      accountName: String,
      recipientCode: String,   // Paystack transfer recipient code
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

RiderSchema.index({ status: 1 });
RiderSchema.index({ kycStatus: 1 });
RiderSchema.index({ 'location.lat': 1, 'location.lng': 1 });

RiderSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

RiderSchema.pre('save', async function (next) {
  if (this.isModified('passwordHash') && this.passwordHash && !this.passwordHash.startsWith('$2')) {
    this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  }
  next();
});

export const Rider = mongoose.model<IRider>('Rider', RiderSchema);
