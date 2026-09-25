import { createPkcePair, randomToken, safeEqual, sha256 } from './crypto.js';
import { clearCookie, parseCookies, secureCookie } from './http.js';
import { storeConsume, storeSet } from './store.js';

export const OAUTH_COOKIE = '__Host-danpro_oauth';
export const OAUTH_FLOW_TTL_SECONDS = 10 * 60;
const FLOW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function flowKey(state) {
  return `oauth:v1:${sha256(state)}`;
}

export async function createAuthFlow(now = Date.now()) {
  const state = randomToken(32);
  const browserBinding = randomToken(32);
  const nonce = randomToken(32);
  const pkce = createPkcePair();
  await storeSet(flowKey(state), {
    version: 1,
    bindingHash: sha256(browserBinding),
    nonce,
    codeVerifier: pkce.verifier,
    createdAt: now,
  }, OAUTH_FLOW_TTL_SECONDS);
  return {
    state,
    nonce,
    challenge: pkce.challenge,
    cookie: secureCookie(OAUTH_COOKIE, browserBinding, OAUTH_FLOW_TTL_SECONDS),
  };
}

export async function consumeAuthFlow(req, state, now = Date.now()) {
  if (!FLOW_TOKEN_PATTERN.test(state ?? '')) return null;
  const record = await storeConsume(flowKey(state));
  const binding = parseCookies(req)[OAUTH_COOKIE];
  if (
    !record
    || record.version !== 1
    || !FLOW_TOKEN_PATTERN.test(binding ?? '')
    || !safeEqual(record.bindingHash, sha256(binding))
    || !FLOW_TOKEN_PATTERN.test(record.nonce ?? '')
    || !FLOW_TOKEN_PATTERN.test(record.codeVerifier ?? '')
    || !Number.isFinite(record.createdAt)
    || now - record.createdAt < -60_000
    || now - record.createdAt > OAUTH_FLOW_TTL_SECONDS * 1000
  ) return null;
  return record;
}

export function clearAuthFlowCookie() {
  return clearCookie(OAUTH_COOKIE);
}

