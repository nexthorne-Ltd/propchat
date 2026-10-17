import { describe, expect, it } from 'vitest';
import { cleanOptions, fieldKeyFrom, normalizeFieldValue, validateFieldDefinition } from './fields';
import { DEFAULT_PRECHAT, normalizePrechat, prechatAsksNothing } from '@/lib/widget/prechat';

describe('ticket field definitions', () => {
  it('makes stable keys from names', () => {
    expect(fieldKeyFrom('Order number')).toBe('order_number');
    expect(fieldKeyFrom('  Plan / Tier ')).toBe('plan_tier');
    expect(fieldKeyFrom('2FA enabled')).toBe('f_2fa_enabled');
    expect(fieldKeyFrom('???')).toBe('field');
  });

  it('requires a name, a known type, and options for a dropdown', () => {
    expect(validateFieldDefinition({ label: '', type: 'text' })).toMatch(/name/);
    expect(validateFieldDefinition({ label: 'X', type: 'colour' })).toMatch(/type/);
    expect(validateFieldDefinition({ label: 'Plan', type: 'dropdown', options: [' ', ''] })).toMatch(/option/);
    expect(validateFieldDefinition({ label: 'Plan', type: 'dropdown', options: ['Pro'] })).toBeNull();
  });

  it('cleans dropdown options', () => {
    expect(cleanOptions([' Pro ', 'pro', '', 'Basic'])).toEqual(['Pro', 'Basic']);
  });
});

describe('ticket field values', () => {
  const field = (type: 'text' | 'number' | 'dropdown' | 'checkbox' | 'date', options: string[] = []) => ({ type, options, label: 'F' });

  it('treats empty as clearing the value', () => {
    expect(normalizeFieldValue(field('text'), '')).toEqual({ value: null });
    expect(normalizeFieldValue(field('number'), null)).toEqual({ value: null });
  });

  it('checks each type', () => {
    expect(normalizeFieldValue(field('number'), '42.5')).toEqual({ value: 42.5 });
    expect(normalizeFieldValue(field('number'), 'abc')).toHaveProperty('error');
    expect(normalizeFieldValue(field('dropdown', ['Pro']), 'Pro')).toEqual({ value: 'Pro' });
    expect(normalizeFieldValue(field('dropdown', ['Pro']), 'Gold')).toHaveProperty('error');
    expect(normalizeFieldValue(field('checkbox'), 'true')).toEqual({ value: true });
    expect(normalizeFieldValue(field('date'), '2026-10-13')).toEqual({ value: '2026-10-13' });
    expect(normalizeFieldValue(field('date'), '13/10/2026')).toHaveProperty('error');
    expect(normalizeFieldValue(field('text'), 'x'.repeat(501))).toHaveProperty('error');
  });
});

describe('pre-chat form config', () => {
  it('defaults to the old behaviour (name optional, email required)', () => {
    expect(normalizePrechat(undefined)).toEqual(DEFAULT_PRECHAT);
  });

  it('drops malformed values and limits topics', () => {
    const c = normalizePrechat({ name: 'sometimes', email: 'off', topics: [' Billing ', 'billing', '', 'Sales', 7], topic_required: true });
    expect(c.name).toBe('optional');
    expect(c.email).toBe('off');
    expect(c.topics).toEqual(['Billing', 'billing', 'Sales', '7']);
    expect(c.topic_required).toBe(true);
  });

  it('a topic cannot be required without topics, and an empty form asks nothing', () => {
    const c = normalizePrechat({ name: 'off', email: 'off', topics: [], topic_required: true });
    expect(c.topic_required).toBe(false);
    expect(prechatAsksNothing(c)).toBe(true);
  });
});
