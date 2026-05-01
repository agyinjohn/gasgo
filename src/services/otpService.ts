import crypto from 'crypto';
import { OTP } from '../models/OTP';
import { CONSTANTS } from '../config/constants';

/**
 * Generate a cryptographically random N-digit OTP code.
 */
function generateCode(length = CONSTANTS.OTP_LENGTH): string {
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  const range = max - min;
  const rand = crypto.randomInt(range);
  return (min + rand).toString();
}

/**
 * Create and persist an OTP for phone verification.
 */
export async function createOTP(
  phone: string,
  purpose: 'registration' | 'login' | 'password_reset'
): Promise<string> {
  // Invalidate any existing OTPs for this phone + purpose
  await OTP.deleteMany({ phone, purpose });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CONSTANTS.OTP_EXPIRES_MINUTES * 60 * 1000);

  await OTP.create({ phone, code, purpose, expiresAt });
  return code;
}

/**
 * Verify an OTP code. Returns true and marks as used on success.
 * Throws descriptive errors on failure.
 */
export async function verifyOTP(
  phone: string,
  code: string,
  purpose: 'registration' | 'login' | 'password_reset'
): Promise<boolean> {
  const otp = await OTP.findOne({ phone, purpose, usedAt: null });

  if (!otp) throw new Error('OTP not found or already used');
  if (otp.expiresAt < new Date()) throw new Error('OTP has expired');
  if (otp.attempts >= CONSTANTS.OTP_MAX_ATTEMPTS) {
    throw new Error('Maximum OTP attempts exceeded. Please request a new code.');
  }

  otp.attempts += 1;

  if (otp.code !== code) {
    await otp.save();
    throw new Error(`Invalid OTP. ${CONSTANTS.OTP_MAX_ATTEMPTS - otp.attempts} attempt(s) remaining.`);
  }

  otp.usedAt = new Date();
  await otp.save();
  return true;
}

/**
 * Generate a 4-digit delivery confirmation OTP for an order.
 * Returns the code and expiry timestamp.
 */
export function generateDeliveryOTP(): { code: string; expiresAt: Date } {
  const code = generateCode(4);
  const expiresAt = new Date(Date.now() + CONSTANTS.OTP_EXPIRES_MINUTES * 60 * 1000);
  return { code, expiresAt };
}
