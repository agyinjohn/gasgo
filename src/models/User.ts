import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IAddress {
  label: string;       // e.g. "Home", "Office"
  street: string;
  city: string;
  lat: number;
  lng: number;
  isDefault: boolean;
}

export interface IPaymentMethod {
  type: 'mobile_money' | 'card' | 'cash';
  provider?: string;   // MTN, Vodafone
  accountNumber?: string;
  last4?: string;
  isDefault: boolean;
}

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  passwordHash?: string;
  googleId?: string;
  profilePhoto?: string;
  savedAddresses: IAddress[];
  paymentMethods: IPaymentMethod[];
  fcmToken?: string;
  isVerified: boolean;
  isActive: boolean;
  totalOrders: number;
  loyaltyPoints: number;
  referralCode: string;
  referredBy?: mongoose.Types.ObjectId;
  referralCount: number;
  ratingAvg: number;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(plain: string): Promise<boolean>;
}

const AddressSchema = new Schema<IAddress>({
  label: { type: String, required: true, trim: true },
  street: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  isDefault: { type: Boolean, default: false },
});

const PaymentMethodSchema = new Schema<IPaymentMethod>({
  type: { type: String, enum: ['mobile_money', 'card', 'cash'], required: true },
  provider: String,
  accountNumber: String,
  last4: String,
  isDefault: { type: Boolean, default: false },
});

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, trim: true, default: '' },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, sparse: true, lowercase: true, trim: true },
    passwordHash: String,
    googleId: { type: String, sparse: true },
    profilePhoto: String,
    savedAddresses: [AddressSchema],
    paymentMethods: [PaymentMethodSchema],
    fcmToken: String,
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    totalOrders: { type: Number, default: 0 },
    loyaltyPoints: { type: Number, default: 0, min: 0 },
    referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
    referralCount: { type: Number, default: 0 },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 }, { sparse: true });

UserSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.pre('save', async function (next) {
  if (this.isModified('passwordHash') && this.passwordHash && !this.passwordHash.startsWith('$2')) {
    this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  }
  next();
});

export const User = mongoose.model<IUser>('User', UserSchema);
