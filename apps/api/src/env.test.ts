import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('env', () => {
  it('throws before any request can be served when JWT_SECRET is unset', async () => {
    delete process.env.JWT_SECRET;
    await expect(import('./env.js')).rejects.toThrow(/JWT_SECRET must be set/);
  });

  it('throws when JWT_SECRET is whitespace-only', async () => {
    process.env.JWT_SECRET = '   ';
    await expect(import('./env.js')).rejects.toThrow(/JWT_SECRET must be set/);
  });

  it('reads DATABASE_URL and JWT_SECRET from process.env when both are set', async () => {
    process.env.DATABASE_URL = 'postgres://custom/db';
    process.env.JWT_SECRET = 'test-secret';
    const { env } = await import('./env.js');
    expect(env.databaseUrl).toBe('postgres://custom/db');
    expect(env.jwtSecret).toBe('test-secret');
  });

  it('applies a documented default for JWT_EXPIRES_IN when unset, and honors an explicit override', async () => {
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.JWT_EXPIRES_IN;
    const defaultEnv = await import('./env.js');
    expect(defaultEnv.env.jwtExpiresIn).toBe('15m');

    vi.resetModules();
    process.env.JWT_EXPIRES_IN = '1h';
    const overriddenEnv = await import('./env.js');
    expect(overriddenEnv.env.jwtExpiresIn).toBe('1h');
  });
});
