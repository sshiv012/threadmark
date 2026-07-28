import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';

const ALGORITHM = 'HS256';

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret);
}

/** Sign a short-lived token carrying `sub: userId`. */
export async function signToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(env.jwtExpiresIn)
    .sign(secretKey());
}

/**
 * Verify a token, returning its `sub` claim. Never throws — any failure
 * (expired, malformed, wrong signature, wrong/unexpected algorithm) resolves
 * to `null` so callers can uniformly respond 401 without a try/catch at every
 * call site.
 */
export async function verifyToken(token: string): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== 'string') return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}
