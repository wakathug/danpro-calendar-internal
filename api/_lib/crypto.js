import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

export function sha256(value) {
  return base64Url(createHash('sha256').update(String(value), 'utf8').digest());
}

export function hmacSha256(secret, value) {
  return base64Url(createHmac('sha256', secret).update(String(value), 'utf8').digest());
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createPkcePair() {
  const verifier = randomToken(48);
  return {
    verifier,
    challenge: sha256(verifier),
  };
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

