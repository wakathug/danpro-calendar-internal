import { getConfig } from './config.js';
import { hmacSha256, normalizeEmail, randomToken, sha256 } from './crypto.js';

const ACTIONS = new Set(['authorize', 'calendar', 'dayDetails']);
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

export class GasAccessDeniedError extends Error {
  constructor() {
    super('Employee access denied');
    this.name = 'GasAccessDeniedError';
  }
}

export class GasUpstreamError extends Error {
  constructor(safeCode = 'upstream_error') {
    super('Apps Script request failed');
    this.name = 'GasUpstreamError';
    this.safeCode = safeCode;
  }
}

export function createSignedGasRequest({ action, email, body = {}, now = Date.now(), nonce = randomToken(24), secret }) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported Apps Script action');
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Invalid authenticated identity');
  const timestamp = String(Math.floor(now / 1000));
  const bodyJson = JSON.stringify(body);
  const bodyHash = sha256(bodyJson);
  const canonical = ['v1', timestamp, nonce, action, normalizedEmail, bodyHash].join('\n');
  return {
    version: 1,
    timestamp,
    nonce,
    action,
    email: normalizedEmail,
    body,
    bodyHash,
    signature: hmacSha256(secret, canonical),
  };
}

export async function callGas(action, email, body = {}, options = {}) {
  const config = getConfig();
  const signed = createSignedGasRequest({
    action,
    email,
    body,
    secret: config.gasSigningSecret,
  });
  let response;
  try {
    response = await fetch(config.gasApiUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new GasUpstreamError(timedOut ? 'timeout' : 'network_error');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GasUpstreamError(response.ok ? 'invalid_json' : `http_${response.status}`);
  }
  if (response.status === 403 || payload?.error === 'ACCESS_DENIED') {
    throw new GasAccessDeniedError();
  }
  if (!response.ok || payload?.ok !== true) {
    throw new GasUpstreamError(!response.ok ? `http_${response.status}` : 'invalid_payload');
  }
  return payload.data;
}

export async function authorizeEmployee(email) {
  const data = await callGas('authorize', email);
  if (data?.authorized !== true) throw new GasAccessDeniedError();
  return true;
}

export function isFreshGasTimestamp(timestamp, now = Date.now()) {
  const parsed = Number(timestamp) * 1000;
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= MAX_CLOCK_SKEW_MS;
}
