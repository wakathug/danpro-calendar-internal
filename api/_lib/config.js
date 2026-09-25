const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const GAS_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function getConfig() {
  const appOrigin = required('APP_ORIGIN').replace(/\/+$/, '');
  const googleClientId = required('GOOGLE_OAUTH_CLIENT_ID');
  const googleClientSecret = required('GOOGLE_OAUTH_CLIENT_SECRET');
  const gasApiUrl = required('INTERNAL_GAS_API_URL');
  const gasSigningSecret = required('INTERNAL_GAS_SIGNING_SECRET');

  const isLocal = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(appOrigin);
  if (!isLocal && !/^https:\/\/[A-Za-z0-9.-]+$/.test(appOrigin)) {
    throw new Error('APP_ORIGIN must be an HTTPS origin');
  }
  if (!GOOGLE_CLIENT_ID_PATTERN.test(googleClientId)) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is invalid');
  }
  if (googleClientSecret.length < 16) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is invalid');
  }
  if (!GAS_URL_PATTERN.test(gasApiUrl)) {
    throw new Error('INTERNAL_GAS_API_URL is invalid');
  }
  if (gasSigningSecret.length < 32) {
    throw new Error('INTERNAL_GAS_SIGNING_SECRET is invalid');
  }

  return Object.freeze({
    appOrigin,
    googleClientId,
    googleClientSecret,
    gasApiUrl,
    gasSigningSecret,
    callbackUrl: `${appOrigin}/api/auth/callback`,
  });
}

