import { clearAuthFlowCookie, consumeAuthFlow } from '../_lib/auth-flow.js';
import { authorizeEmployeeForLogin, GasUpstreamError } from '../_lib/gas-client.js';
import { queryValue, redirect, requestIp, requireMethod, sendJson } from '../_lib/http.js';
import {
  exchangeAuthorizationCode,
  GOOGLE_ISSUER,
  OAuthTokenExchangeError,
  OAuthClaimRejectedError,
  verifyGoogleIdToken,
} from '../_lib/oauth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import { createSession } from '../_lib/session.js';

const AUTH_CODE_PATTERN = /^[A-Za-z0-9_\/.~-]{8,4096}$/;
const TOKEN_REJECTION_CODES = new Set(['invalid_grant', 'access_denied', 'invalid_request']);
const ID_TOKEN_REJECTION_CODES = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID', 'ERR_JWT_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED',
]);
const SAFE_FAILURE_CODES = new Set([
  'timeout', 'network_error', 'invalid_json', 'invalid_payload', 'upstream_error',
  'invalid_client', 'unauthorized_client', 'temporarily_unavailable', 'server_error',
]);

function safeErrorCode(error, stage) {
  if (SAFE_FAILURE_CODES.has(error?.safeCode)) return error.safeCode;
  if (error instanceof GasUpstreamError && /^http_[45][0-9]{2}$/.test(error.safeCode)) {
    return error.safeCode;
  }
  if (stage === 'id_token_verification' && ID_TOKEN_REJECTION_CODES.has(error?.code)) {
    return error.code.toLowerCase();
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'internal_error';
}

function logCallbackFailure(stage, code = 'internal_error', rejected = true) {
  const message = JSON.stringify({
    event: rejected ? 'oauth_callback_rejected' : 'oauth_callback_failed',
    oauth_callback_stage: `${stage}_failed`,
    error_code: code,
  });
  if (rejected) console.warn(message);
  else console.error(message);
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
      logCallbackFailure(stage, 'provider_rejected');
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
    const authorizationStartedAt = Date.now();
    const authorization = await authorizeEmployeeForLogin(identity.email);
    if (!authorization.authorized) {
      logCallbackFailure(stage, authorization.refusalCode);
      const denied = authorization.refusalCode === 'access_denied';
      return sendJson(res, denied ? 403 : 401, { error: denied ? 'ACCESS_DENIED' : 'LOGIN_FAILED' },
        { 'Set-Cookie': clearFlowCookie });
    }
    stage = 'session_creation';
    const newSession = await createSession(identity.email, Date.now(), {
      lastAuthorizedAt: authorizationStartedAt,
    });
    stage = 'cookie_issue';
    redirect(res, '/', [clearFlowCookie, newSession.cookie]);
  } catch (error) {
    if ((stage === 'token_exchange' && error instanceof OAuthTokenExchangeError
      && TOKEN_REJECTION_CODES.has(error.safeCode))
      || (stage === 'id_token_verification'
        && (error instanceof OAuthClaimRejectedError || ID_TOKEN_REJECTION_CODES.has(error?.code)))) {
      const rejectionCode = error instanceof OAuthTokenExchangeError ? error.safeCode
        : error instanceof OAuthClaimRejectedError ? 'invalid_id_token_claims' : error.code.toLowerCase();
      logCallbackFailure(stage, rejectionCode);
      return sendJson(res, 401, { error: 'LOGIN_FAILED' }, { 'Set-Cookie': clearFlowCookie });
    }
    logCallbackFailure(stage, safeErrorCode(error, stage), false);
    const status = error instanceof GasUpstreamError || stage === 'token_exchange' ? 502 : 500;
    return sendJson(res, status, { error: 'LOGIN_FAILED' }, { 'Set-Cookie': clearFlowCookie });
  }
}
