import { createHmac } from 'node:crypto';
import { config } from './config.js';

/**
 * Validate a South African ID number: YYMMDD SSSS C A Z
 *  - YYMMDD date of birth, SSSS gender sequence, C citizenship (0 citizen,
 *    1 permanent resident), A (historically race, now 8/9), Z Luhn check digit.
 */
export function validateSaIdNumber(id: string): { valid: true; dateOfBirth: string; citizen: boolean } | { valid: false; reason: string } {
  if (!/^\d{13}$/.test(id)) return { valid: false, reason: 'ID number must be 13 digits' };

  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  const currentYY = new Date().getUTCFullYear() % 100;
  const year = yy <= currentYY ? 2000 + yy : 1900 + yy;
  const dob = new Date(Date.UTC(year, mm - 1, dd));
  if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== mm - 1 || dob.getUTCDate() !== dd) {
    return { valid: false, reason: 'ID number contains an invalid date of birth' };
  }
  const citizenship = id[10];
  if (citizenship !== '0' && citizenship !== '1') return { valid: false, reason: 'Invalid citizenship digit' };
  if (!luhnValid(id)) return { valid: false, reason: 'ID number checksum is invalid' };

  return { valid: true, dateOfBirth: dob.toISOString().slice(0, 10), citizen: citizenship === '0' };
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ageOn(dateOfBirth: string, now = new Date()): number {
  const dob = new Date(dateOfBirth + 'T00:00:00Z');
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** Keyed hash so we can detect one identity opening multiple accounts without storing ID numbers. */
export const hashIdNumber = (id: string) => createHmac('sha256', config.KYC_PEPPER).update(id).digest('hex');
