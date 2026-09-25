import { clearAuthFlowCookie, consumeAuthFlow } from '../_lib/auth-flow.js';
import { authorizeEmployee, GasAccessDeniedError } from '../_lib/gas-client.js';
import { queryValue, redirect, requestIp, requireMethod, sendJson } from '../_lib/http.js';
import {
  exchangeAuthorizationCode,
  GOOGLE_ISSUER,
  verifyGoogleIdToken,
} from '../_lib/oauth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import { createSession } from '../_lib/session.js';

const AUTH_CODE_PATTERN = /^[A-Za-z0-9_\/.~-]{8,4096}$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function safeErrorCode(error, stage) {
  if (typeof error?.safeCode === 'string' && SAFE_ERROR_CODE_PATTERN.test(error.safeCode)) {
    return error.safeCode.toLowerCase();
  }
  if (stage === 'id_token_verification'
    && typeof error?.code === 'string'
    && /^ERR_[A-Z0-9_]{1,60}$/.test(error.code)) {
    return error.code.toLowerCase();
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'internal_error';
}

function logCallbackFailure(stage, code = 'internal_error') {
  const safeCode = SAFE_ERROR_CODE_PATTERN.test(String(code)) ? String(code).toLowerCase() : 'internal_error';
  console.error(JSON.stringify({
    event: 'oauth_callback_failed',
    oauth_callback_stage: `${stage}_failed`,
    error_code: safeCode,
  }));
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const clearFlowCookie = clearAuthFlowCookie();
  let stage = 'rate_limit';
  try {
    const allowed = await checkRateLimit('auth-callback', requestIp(req), 30, 10 * 60);
    if (!allowed) {
      logCallbackFailure(stage, 'rate_limited');
      return sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Set-Cookie': clearFlowCookie });
    }

    stage = 'oauth_state_validation';
    const state = queryValue(req, 'state');
    const flow = await consumeAuthFlow(req, state);
    if (!flow) {
      logCallbackFailure(stage, 'invalid_state_or_pkce_record');
      return sendJson(res, 400, { error: 'INVALID_OAUTH_STATE' }, { 'Set-Cookie': clearFlowCookie });
    }

    stage = 'authorization_response_validation';
    const responseIssuer = queryValue(req, 'iss');
    if (responseIssuer && responseIssuer !== GOOGLE_ISSUER) {
      logCallbackFailure(stage, 'invalid_issuer');
      return sendJson(res, 400, { error: 'INVALID_OAUTH_ISSUER' }, { 'Set-Cookie': clearFlowCookie });
    }
    const providerError = queryValue(req, 'error');
    if (providerError) {
      logCallbackFailure(stage, SAFE_ERROR_CODE_PATTERN.test(providerError) ? providerError : 'provider_rejected');
      return sendJson(res, 401, { error: 'LOGIN_REJECTED' }, { 'Set-Cookie': clearFlowCookie });
    }
    const code = queryValue(req, 'code');
    if (!AUTH_CODE_PATTERN.test(code ?? '')) {
      logCallbackFailure(stage, 'invalid_authorization_code');
      return sendJson(res, 400, { error: 'INVALID_AUTHORIZATION_CODE' }, { 'Set-Cookie': clearFlowCookie });
    }

    stage = 'token_exchange';
    const idToken = await exchangeAuthorizationCode(code, flow.codeVerifier);
    stage = 'id_token_verification';
    const identity = await verifyGoogleIdToken(idToken, flow.nonce);
    stage = 'employee_authorization';
    await authorizeEmployee(identity.email);
    stage = 'session_creation';
    const newSession = await createSession(identity.email);
    stage = 'cookie_issue';
    redirect(res, '/', [clearFlowCookie, newSession.cookie]);
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      logCallbackFailure(stage, 'access_denied');
      return sendJson(res, 403, { error: 'ACCESS_DENIED' }, { 'Set-Cookie': clearFlowCookie });
    }
    logCallbackFailure(stage, safeErrorCode(error, stage));
    sendJson(res, 401, { error: 'LOGIN_FAILED' }, { 'Set-Cookie': clearFlowCookie });
  }
}
