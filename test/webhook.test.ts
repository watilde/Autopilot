import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/github/webhook.js';
import { Store } from '../src/db/index.js';

const SECRET = 'a-shared-secret';

describe('webhook signature verification', () => {
  const body = JSON.stringify({ action: 'labeled', issue: { number: 1 } });

  it('accepts a correctly signed payload', () => {
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('rejects a payload signed with the wrong secret', () => {
    const r = verifySignature(body, signPayload(body, 'wrong'), SECRET);
    expect(r.ok).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = signPayload(body, SECRET);
    const r = verifySignature(body.replace('"number":1', '"number":999'), sig, SECRET);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const r = verifySignature(body, undefined, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing/);
  });

  it('rejects a non-sha256 scheme', () => {
    const r = verifySignature(body, 'sha1=deadbeef', SECRET);
    expect(r.ok).toBe(false);
  });

  // Hostile input must produce a clean rejection, not a thrown 500.
  it('rejects a malformed hex digest without throwing', () => {
    for (const bad of ['sha256=', 'sha256=zzzz', 'sha256=abc', `sha256=${'f'.repeat(63)}`]) {
      const r = verifySignature(body, bad, SECRET);
      expect(r.ok).toBe(false);
    }
  });

  it('verifies over raw bytes, not re-serialised JSON', () => {
    // GitHub sends pretty-printed JSON; a parse/stringify round-trip drops the
    // whitespace and changes the bytes the digest was computed over. This is
    // why the server keeps rawBody instead of re-encoding request.body.
    const raw = '{\n  "action": "labeled",\n  "issue": { "number": 1 }\n}';
    const sig = signPayload(raw, SECRET);
    const roundTripped = JSON.stringify(JSON.parse(raw));

    expect(roundTripped).not.toBe(raw);
    expect(verifySignature(raw, sig, SECRET).ok).toBe(true);
    expect(verifySignature(roundTripped, sig, SECRET).ok).toBe(false);
  });
});

describe('delivery idempotency', () => {
  it('accepts a delivery id once and rejects the retry', () => {
    const store = new Store(':memory:');
    expect(store.recordDelivery('uuid-1', 'issues', 'labeled')).toBe(true);
    expect(store.recordDelivery('uuid-1', 'issues', 'labeled')).toBe(false);
    expect(store.recordDelivery('uuid-2', 'issues', 'labeled')).toBe(true);
  });
});
