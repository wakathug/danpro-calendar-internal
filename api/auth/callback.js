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

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const clearFlowCookie = clearAuthFlowCookie();
  try {
    const allowed = await checkRateLimit('auth-callback', requestIp(req), 30, 10 * 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Set-Cookie': clearFlowCookie });

    const state = queryValue(req, 'state');
    const flow = await consumeAuthFlow(req, state);
    if (!flow) return sendJson(res, 400, { error: 'INVALID_OAUTH_STATE' }, { 'Set-Cookie': clearFlowCookie });

    const responseIssuer = queryValue(req, 'iss');
    if (responseIssuer && responseIssuer !== GOOGLE_ISSUER) {
      return sendJson(res, 400, { error: 'INVALID_OAUTH_ISSUER' }, { 'Set-Cookie': clearFlowCookie });
    }
    if (queryValue(req, 'error')) {
      return sendJson(res, 401, { error: 'LOGIN_REJECTED' }, { 'Set-Cookie': clearFlowCookie });
    }
    const code = queryValue(req, 'code');
    if (!AUTH_CODE_PATTERN.test(code ?? '')) {
      return sendJson(res, 400, { error: 'INVALID_AUTHORIZATION_CODE' }, { 'Set-Cookie': clearFlowCookie });
    }

    const idToken = await exchangeAuthorizationCode(code, flow.codeVerifier);
    const identity = await verifyGoogleIdToken(idToken, flow.nonce);
    await authorizeEmployee(identity.email);
    const newSession = await createSession(identity.email);
    redirect(res, '/', [clearFlowCookie, newSession.cookie]);
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      return sendJson(res, 403, { error: 'ACCESS_DENIED' }, { 'Set-Cookie': clearFlowCookie });
    }
    sendJson(res, 401, { error: 'LOGIN_FAILED' }, { 'Set-Cookie': clearFlowCookie });
  }
}

