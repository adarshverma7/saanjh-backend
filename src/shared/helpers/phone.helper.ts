import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';

/**
 * Normalises a raw phone string to E.164 format for Indian mobile numbers.
 * Throws BadRequestException if the result is not a valid +91 mobile number.
 *
 * Accepts: 9876543210 | 919876543210 | +919876543210 | 09876543210
 * Returns: +91XXXXXXXXXX
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  let normalized: string;

  if (digits.length === 10) {
    normalized = `+91${digits}`;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    normalized = `+${digits}`;
  } else if (digits.length === 13 && digits.startsWith('091')) {
    normalized = `+${digits.slice(1)}`;
  } else {
    throw new BadRequestException({
      error: 'INVALID_PHONE',
      message: 'Phone must be a valid 10-digit Indian mobile number',
    });
  }

  // Validate: Indian mobile numbers start with 6, 7, 8, or 9
  if (!/^\+91[6-9]\d{9}$/.test(normalized)) {
    throw new BadRequestException({
      error: 'INVALID_PHONE',
      message: 'Phone must be a valid Indian mobile number (starts with 6–9)',
    });
  }

  return normalized;
}

/**
 * HMAC-SHA256 hash of a normalised phone number using a server-side salt.
 * Used for contact matching without exposing raw phone numbers.
 *
 * IMPORTANT: The salt must NEVER change once users are in production.
 * Changing the salt would break all existing contact matches.
 */
export function hashPhone(normalized: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(normalized).digest('hex');
}

/**
 * SHA-256 hash of an OTP.
 * OTPs are never stored as plain text — only this hash is persisted.
 */
export function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

/**
 * SHA-256 hash of a refresh token.
 * Refresh tokens are never stored as plain text.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a cryptographically random 6-digit OTP.
 */
export function generateOtp(): string {
  // Use crypto.randomInt for uniform distribution (avoids modulo bias)
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Generates an 8-character invite code using only unambiguous characters.
 * Excludes 0, O, 1, I to prevent confusion when typed manually.
 */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8))
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Masks a phone number for API responses.
 * +919876543210 → +91XXXXXX3210
 * Never return the full phone in any API response.
 */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '****';
  return phone.slice(0, -4).replace(/[0-9]/g, 'X') + phone.slice(-4);
}
