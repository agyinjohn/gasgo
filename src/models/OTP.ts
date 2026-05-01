import mongoose, { Document, Schema } from 'mongoose';

export interface IOTP extends Document {
  phone: string;
  code: string;
  purpose: 'registration' | 'login' | 'password_reset';
  attempts: number;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

const OTPSchema = new Schema<IOTP>(
  {
    phone: { type: String, required: true, trim: true },
    code: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['registration', 'login', 'password_reset'],
      required: true,
    },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true }
);

OTPSchema.index({ phone: 1, purpose: 1 });
// Auto-delete expired OTPs after 1 hour
OTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const OTP = mongoose.model<IOTP>('OTP', OTPSchema);
