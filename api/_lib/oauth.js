import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getConfig } from './config.js';
import { normalizeEmail, safeEqual } from './crypto.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = new URL('https://www.googleapis.com/oauth2/v3/certs');

let googleJwks;

function getGoogleJwks() {
  if (!googleJwks) googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URI);
  return googleJwks;
}

export function buildGoogleAuthorizationUrl({ state, nonce, challenge }) {
  const config = getConfig();
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeAuthorizationCode(code, codeVerifier) {
  const config = getConfig();
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.callbackUrl,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.id_token !== 'string') {
    throw new Error('OAuth code exchange failed');
  }
  return payload.id_token;
}

export function validateGoogleClaims(payload, expectedNonce, expectedAudience, now = Date.now()) {
  if (payload?.iss !== GOOGLE_ISSUER) throw new Error('Invalid token issuer');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAudience)) throw new Error('Invalid token audience');
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) throw new Error('Expired token');
  if (!Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60_000) throw new Error('Invalid token time');
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expectedNonce)) {
    throw new Error('Invalid token nonce');
  }
  if (payload.email_verified !== true) throw new Error('Unverified email');
  const email = normalizeEmail(payload.email);
  if (!email) throw new Error('Missing verified email');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing subject');
  return { email, subject: payload.sub };
}

export async function verifyGoogleIdToken(idToken, expectedNonce, options = {}) {
  const config = getConfig();
  const keySet = options.keySet ?? getGoogleJwks();
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: GOOGLE_ISSUER,
    audience: config.googleClientId,
    algorithms: ['RS256'],
    clockTolerance: 5,
  });
  return validateGoogleClaims(payload, expectedNonce, config.googleClientId, options.now ?? Date.now());
}

