import { createAuthFlow } from '../_lib/auth-flow.js';
import { getConfig } from '../_lib/config.js';
import { redirect, requestIp, requireMethod, sendJson } from '../_lib/http.js';
import { buildGoogleAuthorizationUrl } from '../_lib/oauth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    getConfig();
    const allowed = await checkRateLimit('auth-login', requestIp(req), 20, 10 * 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    const flow = await createAuthFlow();
    const url = buildGoogleAuthorizationUrl(flow);
    redirect(res, url, [flow.cookie]);
  } catch {
    sendJson(res, 503, { error: 'AUTH_UNAVAILABLE' });
  }
}
