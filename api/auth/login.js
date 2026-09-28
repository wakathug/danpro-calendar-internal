import { createAuthFlow } from '../_lib/auth-flow.js';
import { getConfig } from '../_lib/config.js';
import { redirect, requestIp, requireMethod, sendJson } from '../_lib/http.js';
import { buildGoogleAuthorizationUrl } from '../_lib/oauth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';

const CONFIG_KEYS = new Set([
  'APP_ORIGIN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'INTERNAL_GAS_API_URL',
  'INTERNAL_GAS_SIGNING_SECRET',
]);

function safeLoginErrorCode(error, stage) {
  if (stage !== 'config') return `${stage}_unavailable`;
  const message = typeof error?.message === 'string' ? error.message : '';
  const missing = /^Missing required environment variable: ([A-Z0-9_]+)$/.exec(message);
  if (missing && CONFIG_KEYS.has(missing[1])) {
    return `missing_${missing[1].toLowerCase()}`;
  }
  if (message === 'APP_ORIGIN must be an HTTPS origin') return 'invalid_app_origin';
  const invalid = /^([A-Z0-9_]+) is invalid$/.exec(message);
  if (invalid && CONFIG_KEYS.has(invalid[1])) {
    return `invalid_${invalid[1].toLowerCase()}`;
  }
  return 'invalid_config';
}

function logLoginFailure(stage, error) {
  console.error(JSON.stringify({
    event: 'auth_login_failed',
    auth_login_stage: `${stage}_failed`,
    error_code: safeLoginErrorCode(error, stage),
  }));
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  let stage = 'config';
  try {
    getConfig();
    stage = 'rate_limit';
    const allowed = await checkRateLimit('auth-login', requestIp(req), 20, 10 * 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    stage = 'auth_flow';
    const flow = await createAuthFlow();
    stage = 'authorization_url';
    const url = buildGoogleAuthorizationUrl(flow);
    redirect(res, url, [flow.cookie]);
  } catch (error) {
    logLoginFailure(stage, error);
    sendJson(res, 503, { error: 'AUTH_UNAVAILABLE' });
  }
}
