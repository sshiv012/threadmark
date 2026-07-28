import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-value';
  process.env.JWT_EXPIRES_IN = '15m';
});

describe('signToken / verifyToken', () => {
  it('round-trips: verifying a freshly signed token resolves to {sub: userId}', async () => {
    const { signToken, verifyToken } = await import('./jwt.js');
    const token = await signToken('user-123');
    expect(await verifyToken(token)).toEqual({ sub: 'user-123' });
  });

  it('the signed token carries a future exp claim', async () => {
    const { signToken } = await import('./jwt.js');
    const token = await signToken('user-123');
    const payloadB64 = token.split('.')[1]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('resolves to null for a garbage/non-JWT string', async () => {
    const { verifyToken } = await import('./jwt.js');
    expect(await verifyToken('not-a-jwt-at-all')).toBeNull();
  });

  it('resolves to null for an empty string', async () => {
    const { verifyToken } = await import('./jwt.js');
    expect(await verifyToken('')).toBeNull();
  });

  it('resolves to null for a token signed with the wrong secret', async () => {
    const { verifyToken } = await import('./jwt.js');
    const wrongSecretToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('a-completely-different-secret'));
    expect(await verifyToken(wrongSecretToken)).toBeNull();
  });

  it('resolves to null for a token using a different algorithm (alg-confusion) even with the same secret bytes', async () => {
    const { verifyToken } = await import('./jwt.js');
    const hs384Token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS384' })
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-secret-value'));
    expect(await verifyToken(hs384Token)).toBeNull();
  });

  it('resolves to null for an expired token', async () => {
    const { verifyToken } = await import('./jwt.js');
    const expiredToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode('test-secret-value'));
    expect(await verifyToken(expiredToken)).toBeNull();
  });

  it.each(['', 'garbage', 'a.b.c', '   '])(
    'never throws for malformed input %j',
    async (malformed) => {
      const { verifyToken } = await import('./jwt.js');
      await expect(verifyToken(malformed)).resolves.toBeNull();
    },
  );
});
