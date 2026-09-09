import { describe, it, expect } from 'vitest';
import { assertRedisUrl } from './redis.module.js';

describe('assertRedisUrl', () => {
  it('accepts a plain localhost URL', () => {
    expect(() => assertRedisUrl('redis://localhost:6379')).not.toThrow();
  });

  it('accepts rediss:// for Upstash (TLS)', () => {
    expect(() => assertRedisUrl('rediss://:token@some-proj.upstash.io:6379')).not.toThrow();
  });

  it('rejects redis:// against an Upstash host', () => {
    expect(() => assertRedisUrl('redis://:token@some-proj.upstash.io:6379')).toThrow(/rediss:\/\//);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertRedisUrl('not-a-url')).toThrow(/not a valid URL/);
  });
});
