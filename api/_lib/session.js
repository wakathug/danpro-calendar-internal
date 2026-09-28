import { normalizeEmail, randomToken, sha256 } from './crypto.js';
import { parseCookies, secureCookie, clearCookie } from './http.js';
import { elapsedMs, startTimer } from './performance.js';
import {
  storeDelete,
  storeGet,
  storeSet,
  storeUpdateSessionAuthorization,
} from './store.js';

export const SESSION_COOKIE = '__Host-danpro_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const AUTHORIZATION_GRACE_MS = 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sessionKey(sessionId) {
  return `session:v1:${sha256(sessionId)}`;
}

export async function createSession(email, now = Date.now(), options = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Cannot create session without a valid identity');
  const sessionId = randomToken(32);
  const session = {
    version: 1,
    email: normalizedEmail,
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
  };
  if (Number.isFinite(options.lastAuthorizedAt)) {
    session.lastAuthorizedAt = Math.trunc(options.lastAuthorizedAt);
  }
  await storeSet(sessionKey(sessionId), session, SESSION_MAX_AGE_SECONDS);
  return {
    sessionId,
    session,
    cookie: secureCookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE_SECONDS),
  };
}

export async function readSession(req, now = Date.now(), timing = null) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return null;
  const storeStartedAt = startTimer();
  const session = await storeGet(sessionKey(sessionId));
  if (timing) timing.upstash = elapsedMs(storeStartedAt);
  if (
    !session
    || session.version !== 1
    || !normalizeEmail(session.email)
    || !Number.isFinite(session.createdAt)
    || !Number.isFinite(session.expiresAt)
    || (
      session.lastAuthorizedAt !== undefined
      && (
        !Number.isInteger(session.lastAuthorizedAt)
        || session.lastAuthorizedAt <= 0
        || session.lastAuthorizedAt > now + 1000
        || session.lastAuthorizedAt > session.expiresAt
      )
    )
    || session.expiresAt <= now
    || session.expiresAt - session.createdAt > SESSION_MAX_AGE_SECONDS * 1000 + 1000
  ) {
    await storeDelete(sessionKey(sessionId));
    return null;
  }
  return { sessionId, session };
}

export function authorizationState(session, now = Date.now()) {
  const lastAuthorizedAt = Number.isInteger(session?.lastAuthorizedAt)
    ? session.lastAuthorizedAt
    : 0;
  const validForMs = Math.max(0, Math.min(
    AUTHORIZATION_GRACE_MS,
    lastAuthorizedAt + AUTHORIZATION_GRACE_MS - now,
  ));
  return {
    fresh: validForMs > 0,
    validForMs,
  };
}

export async function updateSessionAuthorization(sessionId, authorizationStartedAt, now = Date.now()) {
  if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return null;
  if (
    !Number.isInteger(authorizationStartedAt)
    || authorizationStartedAt <= 0
    || authorizationStartedAt > now + 1000
  ) return null;
  const updated = Number(await storeUpdateSessionAuthorization(
    sessionKey(sessionId),
    authorizationStartedAt,
  ));
  return Number.isInteger(updated) && updated > 0 ? updated : null;
}

export function authorizationResponse(lastAuthorizedAt, now = Date.now(), revalidated = true) {
  return {
    revalidated: Boolean(revalidated),
    validForMs: authorizationState({ lastAuthorizedAt }, now).validForMs,
  };
}

export async function deleteSession(sessionId) {
  if (SESSION_ID_PATTERN.test(sessionId ?? '')) {
    await storeDelete(sessionKey(sessionId));
  }
}

export async function deleteRequestSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  await deleteSession(sessionId);
}

export function clearSessionCookie() {
  return clearCookie(SESSION_COOKIE);
}
