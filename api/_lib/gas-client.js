import { getConfig } from './config.js';
import { hmacSha256, normalizeEmail, randomToken, sha256 } from './crypto.js';
import { elapsedMs, logGasInternalTiming, startTimer } from './performance.js';

const ACTIONS = new Set(['authorize', 'calendar', 'dayDetails']);
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const INTERNAL_TIMING_METRICS = Object.freeze([
  'requestParseMs',
  'timestampValidationMs',
  'signingSecretReadMs',
  'bodyDigestMs',
  'hmacComputeMs',
  'signatureCompareMs',
  'nonceLockWaitMs',
  'nonceLookupMs',
  'nonceWriteMs',
  'drivePermissionsReadMs',
  'groupExpansionMs',
  'accessPolicyBuildMs',
  'employeeMembershipMatchMs',
  'calendarAggregateReadMs',
  'responseSerializeMs',
  'gasAppTotalMs',
  'gasUnattributedMs',
]);

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
  const startedAt = startTimer();
  const config = getConfig();
  const signed = createSignedGasRequest({
    action,
    email,
    body,
    secret: config.gasSigningSecret,
  });
  let response;
  let gasFetchMs;
  try {
    response = await fetch(config.gasApiUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    gasFetchMs = elapsedMs(startedAt);
    if (typeof options.onTiming === 'function') options.onTiming({ gasFetch: gasFetchMs });
  } catch (error) {
    if (typeof options.onTiming === 'function') {
      options.onTiming({ gasFetch: elapsedMs(startedAt) });
    }
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new GasUpstreamError(timedOut ? 'timeout' : 'network_error');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GasUpstreamError(response.ok ? 'invalid_json' : `http_${response.status}`);
  }
  if (typeof options.onTiming === 'function') {
    options.onTiming({ gasTotal: elapsedMs(startedAt) });
  }
  if (response.status === 403 || payload?.error === 'ACCESS_DENIED') {
    if (action === 'authorize' && options.authorizationRefusalsAsResult === true) {
      return { authorized: false, refusalCode: 'access_denied' };
    }
    throw new GasAccessDeniedError();
  }
  if (!response.ok || payload?.ok !== true) {
    if (response.ok && action === 'authorize' && options.authorizationRefusalsAsResult === true) {
      return { authorized: false, refusalCode: 'invalid_payload' };
    }
    throw new GasUpstreamError(!response.ok ? `http_${response.status}` : 'invalid_payload');
  }
  const internalTiming = payload.data?.internalTiming;
  if (payload.data && Object.prototype.hasOwnProperty.call(payload.data, 'internalTiming')) {
    delete payload.data.internalTiming;
  }
  const safeInternalTiming = {};
  for (const name of INTERNAL_TIMING_METRICS) {
    const value = internalTiming?.[name];
    if (Number.isFinite(value) && value >= 0 && value <= (options.timeoutMs ?? 30_000)) {
      safeInternalTiming[name] = Math.round(value * 10) / 10;
    }
  }
  if (INTERNAL_TIMING_METRICS.every((name) => Object.hasOwn(safeInternalTiming, name))) {
    const gasTransportAndPlatformMs = (
      Math.round((gasFetchMs - safeInternalTiming.gasAppTotalMs) * 10) / 10
    );
    logGasInternalTiming(action, {
      gasFetchMs,
      gasTransportAndPlatformMs,
      ...safeInternalTiming,
    });
  }
  if (typeof options.onTiming === 'function' && payload.data?.serverTiming) {
    const reported = payload.data.serverTiming;
    const safeReported = {};
    const reportedMetrics = {
      gasHmac: reported.hmacVerificationMs,
      gasPermission: reported.employeePermissionCheckMs,
      gasAggregate: reported.calendarAggregateReadMs,
    };
    for (const [name, value] of Object.entries(reportedMetrics)) {
      if (Number.isFinite(value) && value >= 0 && value <= (options.timeoutMs ?? 30_000)) {
        safeReported[name] = value;
      }
    }
    options.onTiming(safeReported);
  }
  return payload.data;
}

export async function authorizeEmployee(email, options = {}) {
  const data = await callGas('authorize', email, {}, options);
  if (data?.authorized !== true) throw new GasAccessDeniedError();
  return true;
}

// Login converts expected authorization refusals into values; other callers keep their error contract.
export async function authorizeEmployeeForLogin(email) {
  const data = await callGas('authorize', email, {}, { authorizationRefusalsAsResult: true });
  if (data?.authorized !== true) {
    return { authorized: false, refusalCode: data?.refusalCode === 'invalid_payload'
      ? 'invalid_payload' : 'access_denied' };
  }
  return { authorized: true };
}

export function isFreshGasTimestamp(timestamp, now = Date.now()) {
  const parsed = Number(timestamp) * 1000;
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= MAX_CLOCK_SKEW_MS;
}
