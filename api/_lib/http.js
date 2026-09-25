export const PRIVATE_NO_STORE = 'private, no-store, max-age=0';

export function setNoStore(res) {
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function sendJson(res, status, body, headers = {}) {
  setNoStore(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

export function sendEmpty(res, status, headers = {}) {
  setNoStore(res);
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end();
}

export function redirect(res, location, cookies = []) {
  setNoStore(res);
  res.statusCode = 302;
  res.setHeader('Location', location);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end();
}

export function parseCookies(req) {
  const result = Object.create(null);
  const header = req.headers?.cookie;
  if (!header) return result;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = '';
    }
  }
  return result;
}

export function secureCookie(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (Number.isInteger(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, maxAgeSeconds)}`);
  return parts.join('; ');
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return false;
}

export function hasValidOrigin(req, appOrigin) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string') return false;
  try {
    const expected = new URL(appOrigin);
    const requestHost = String(req.headers?.['x-forwarded-host'] ?? req.headers?.host ?? '').toLowerCase();
    const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] ?? expected.protocol.slice(0, -1)).toLowerCase();
    return new URL(origin).origin === expected.origin
      && requestHost === expected.host.toLowerCase()
      && forwardedProtocol === expected.protocol.slice(0, -1);
  } catch {
    return false;
  }
}

export function requestIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 128);
  }
  return String(req.socket?.remoteAddress ?? 'unknown').slice(0, 128);
}

export function queryValue(req, name) {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}
