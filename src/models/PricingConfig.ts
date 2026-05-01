import mongoose, { Document, Schema } from 'mongoose';

export interface IPricingConfig extends Document {
  deliveryFeeFlat: number;        // flat delivery fee in GHS
  surgeMultiplier: number;        // 1.0 = no surge, 1.5 = 50% surge
  surgeActive: boolean;
  surgeReason?: string;
  minPriceCaps: { size: number; min: number }[];
  maxPriceCaps: { size: number; max: number }[];
  priceFreezeActive: boolean;
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const PricingConfigSchema = new Schema<IPricingConfig>(
  {
    deliveryFeeFlat: { type: Number, default: 5, min: 0 },
    surgeMultiplier: { type: Number, default: 1.0, min: 1.0, max: 5.0 },
    surgeActive: { type: Boolean, default: false },
    surgeReason: String,
    minPriceCaps: [{ size: Number, min: Number }],
    maxPriceCaps: [{ size: Number, max: Number }],
    priceFreezeActive: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

export const PricingConfig = mongoose.model<IPricingConfig>('PricingConfig', PricingConfigSchema);
