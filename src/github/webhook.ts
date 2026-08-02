import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub signs every webhook delivery with HMAC-SHA256 over the raw body.
 *
 * This endpoint is the system's only unauthenticated entry point, and a
 * successful forgery would let anyone spend our Devin budget and open PRs
 * against the repo. So: verify against the *raw* bytes (re-serialising JSON
 * changes them and breaks the digest), compare in constant time, and reject
 * anything malformed rather than trying to be lenient.
 */

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: 'missing X-Hub-Signature-256 header' };
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'signature header is not sha256' };
  }

  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();

  const providedHex = signatureHeader.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
    return { ok: false, reason: 'signature is not a valid hex digest' };
  }
  const provided = Buffer.from(providedHex, 'hex');

  // Lengths are equal by construction above, but timingSafeEqual throws on a
  // mismatch, so guard rather than risk a 500 on hostile input.
  if (provided.length !== expected.length) return { ok: false, reason: 'signature length mismatch' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}

/** Helper used by the simulator and tests to produce a valid signature. */
export function signPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}
