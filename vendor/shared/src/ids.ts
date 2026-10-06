import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 26-character ULID: 48-bit millisecond timestamp + 80-bit randomness,
 * Crockford base32. Lexicographically sortable by creation time.
 */
export function newUlid(now: number = Date.now()): string {
  const time = BigInt(now);
  const random = bytesToBigInt(randomBytes(10));
  return `${encodeBase32(time, 10)}${encodeBase32(random, 16)}`;
}

export function newContainerId(now: number = Date.now()): string {
  return `ctr_${newUlid(now)}`;
}

export function newUserId(): string {
  return `usr_${newUlid()}`;
}

export function newSessionId(): string {
  return `ssn_${newUlid()}`;
}

export function newApiTokenId(): string {
  return `tok_${newUlid()}`;
}

export function newRequestId(): string {
  return `req_${newUlid()}`;
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let out = "";

  for (let index = 0; index < length; index += 1) {
    const digit = Number(remaining & 31n);
    out = `${CROCKFORD_BASE32[digit] ?? "0"}${out}`;
    remaining >>= 5n;
  }

  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
