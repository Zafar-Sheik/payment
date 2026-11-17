import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../src/money.js';
import { ageOn, validateSaIdNumber } from '../src/kyc.js';
import { validSaId } from './helpers.js';

describe('money', () => {
  it('parses rand strings into integer cents', () => {
    expect(parseAmount('0.01')).toBe(1n);
    expect(parseAmount('10')).toBe(1000n);
    expect(parseAmount('10.5')).toBe(1050n);
    expect(parseAmount('1234.56')).toBe(123456n);
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', '-1', '1.234', '1e3', '01', 'abc', '1,000', '.5', 'NaN']) {
      expect(() => parseAmount(bad), bad).toThrow();
    }
  });

  it('avoids floating point drift', () => {
    expect(parseAmount('0.1') + parseAmount('0.2')).toBe(parseAmount('0.3'));
  });

  it('formats cents', () => {
    expect(formatAmount(0n)).toBe('0.00');
    expect(formatAmount(5n)).toBe('0.05');
    expect(formatAmount(123456n)).toBe('1234.56');
    expect(formatAmount(-1050n)).toBe('-10.50');
  });
});

describe('SA ID validation', () => {
  it('accepts a valid ID number', () => {
    const r = validateSaIdNumber(validSaId());
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.dateOfBirth).toBe('1980-01-01');
  });

  it('rejects a bad checksum', () => {
    const id = validSaId();
    const wrong = id.slice(0, 12) + ((Number(id[12]) + 1) % 10);
    expect(validateSaIdNumber(wrong)).toMatchObject({ valid: false });
  });

  it('rejects impossible dates and wrong length', () => {
    expect(validateSaIdNumber('8013015009087')).toMatchObject({ valid: false });
    expect(validateSaIdNumber('12345')).toMatchObject({ valid: false });
  });

  it('computes age', () => {
    expect(ageOn('2000-06-15', new Date('2018-06-14T00:00:00Z'))).toBe(17);
    expect(ageOn('2000-06-15', new Date('2018-06-15T00:00:00Z'))).toBe(18);
  });
});
