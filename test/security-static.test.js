import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSignedGasRequest } from '../api/_lib/gas-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Vercel to GAS request is HMAC signed without sending the secret', () => {
  const secret = 'a-secret-value-that-never-leaves-the-server';
  const request = createSignedGasRequest({
    action: 'dayDetails',
    email: 'Employee@Example.com',
    body: { date: '2026-09-25', expectedRevision: 'revision' },
    now: 1_700_000_000_000,
    nonce: 'A'.repeat(32),
    secret,
  });
  assert.equal(request.email, 'employee@example.com');
  assert.equal(request.timestamp, '1700000000');
  assert.match(request.signature, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(request).includes(secret), false);
});

test('frontend has no inline executable content and waits for session before localStorage restore', () => {
  const html = read('public/index.html');
  const script = read('public/app.js');
  const boot = script.slice(script.indexOf('async function boot()'));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.ok(boot.indexOf("fetchJson('/api/auth/session'") < boot.indexOf('restoreCachedCalendar(cacheUserKey)'));
  assert.match(script, /if \(!sessionConfirmed\) return false/);
  assert.match(script, /ACTIVE_USER_STORAGE_KEY/);
  assert.match(script, /USER_CACHE_KEY_PATTERN/);
  assert.match(script, /function clearEmployeeState\(\)[\s\S]*clearCachedCalendar\(\)[\s\S]*invalidateDetailCache\(\)/);
  assert.match(script, /let detailsAuthorized = false/);
  assert.match(script, /if \(!detailsAuthorized\) return Promise\.reject/);
  assert.match(script, /if \(!hoverCapable\.matches \|\| !detailsAuthorized\) return/);
  assert.match(script, /function failClosedSummary\(\)[\s\S]*calendarData = new Map\(\)/);
  assert.match(script, /authorization\.validForMs > AUTHORIZATION_GRACE_MS/);
  assert.doesNotMatch(script, /localStorage[\s\S]{0,120}(customer|content|period|email|token|session)/i);
});

test('security headers are strict and employee APIs cannot be shared-cacheable', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const headers = Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-inline|unsafe-eval/);
  assert.match(headers['Strict-Transport-Security'], /max-age=63072000/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.match(read('api/_lib/http.js'), /private, no-store, max-age=0/);
  assert.doesNotMatch(read('api/_lib/http.js'), /s-maxage|stale-while-revalidate/);
  assert.equal(vercel.git.deploymentEnabled.main, false);
  const store = read('api/_lib/store.js');
  assert.match(store, /candidate > current/);
  assert.match(store, /'KEEPTTL'/);
});

test('new Apps Script project is API-only, HMACs email policy, blocks direct GET, and has no writes', () => {
  const gas = read('gas-internal-api/Code.js');
  const calendarRequestPath = gas.slice(
    gas.indexOf('function getInternalApiCalendarData_'),
    gas.indexOf('function getInternalApiDayDetails_'),
  );
  assert.match(gas, /function doGet\(\)[\s\S]*METHOD_NOT_ALLOWED/);
  assert.doesNotMatch(gas, /HtmlService/);
  assert.match(gas, /function readAccessPolicyHmacSecret_\(\)[\s\S]*accessPolicyHmacSecretProperty/);
  assert.match(gas, /function hashEmail_\(email, accessPolicyHmacSecret\)[\s\S]*computeHmacSha256Signature/);
  assert.doesNotMatch(gas, /function hashEmail_\([^)]*\)[\s\S]{0,300}PropertiesService/);
  assert.match(gas, /consumeNonce_\(request\.nonce, internalTiming\)/);
  assert.match(gas, /signatureClockSkewSeconds: 120/);
  assert.match(gas, /hmacVerificationMs/);
  assert.match(gas, /employeePermissionCheckMs/);
  assert.match(gas, /calendarAggregateReadMs/);
  assert.match(gas, /function ensureCalendarAggregateTrigger\(\)/);
  assert.match(gas, /newTrigger\(handler\)\.timeBased\(\)\.everyMinutes\(1\)\.create\(\)/);
  assert.ok(gas.indexOf('const created = ScriptApp.newTrigger') < gas.indexOf('existing.forEach((trigger) => ScriptApp.deleteTrigger(trigger))'));
  assert.match(gas, /function getCalendarAggregateTriggerState\(\)/);
  assert.doesNotMatch(calendarRequestPath, /openSpreadsheet_|buildFreshCalendarData_|getRange\(/);
  assert.doesNotMatch(gas, /\.setValue\(|\.setValues\(|\.appendRow\(|\.deleteRow\(|\.insertRow/);
});

test('Apps Script manifest grants the scope required by SpreadsheetApp without write code', () => {
  const manifest = JSON.parse(read('gas-internal-api/appsscript.json'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.equal(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'), false);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING',
  });
  const gas = read('gas-internal-api/Code.js');
  assert.doesNotMatch(gas, /\.setValue\(|\.setValues\(|\.appendRow\(|\.deleteRow\(|\.insertRow/);
});

test('Vercel production logging is limited to safe OAuth stage codes and timings', () => {
  const callbackPath = path.normalize('auth/callback.js');
  const loginPath = path.normalize('auth/login.js');
  const apiFiles = fs.readdirSync(path.join(root, 'api'), { recursive: true })
    .filter((file) => String(file).endsWith('.js'));
  const callback = read(path.join('api', callbackPath));
  const login = read(path.join('api', loginPath));
  const performancePath = path.normalize('_lib/performance.js');
  const performanceLogger = read(path.join('api', performancePath));
  const otherApi = apiFiles
    .filter((file) => ![callbackPath, loginPath, performancePath].includes(path.normalize(String(file))))
    .map((file) => read(path.join('api', String(file))))
    .join('\n');
  assert.doesNotMatch(otherApi, /console\.(log|info|warn|error)/);
  assert.equal((callback.match(/console\.error/g) || []).length, 1);
  assert.equal((callback.match(/console\.warn/g) || []).length, 1);
  assert.doesNotMatch(callback, /console\.(log|info)/);
  assert.match(callback, /event: rejected \? 'oauth_callback_rejected' : 'oauth_callback_failed'/);
  assert.doesNotMatch(callback, /JSON\.stringify\([^)]*(session|email|customer|content|token|codeVerifier)/i);
  assert.equal((login.match(/console\.error/g) || []).length, 1);
  assert.doesNotMatch(login, /console\.(log|info|warn)/);
  assert.match(login, /event: 'auth_login_failed'/);
  assert.match(login, /auth_login_stage: `\$\{stage\}_failed`/);
  assert.match(login, /error_code: safeLoginErrorCode\(error, stage\)/);
  assert.doesNotMatch(login, /JSON\.stringify\([^)]*(session|email|customer|content|token|secret)/i);
  assert.equal((performanceLogger.match(/console\.info/g) || []).length, 2);
  assert.match(performanceLogger, /event: 'performance_timing'/);
  assert.match(performanceLogger, /event: 'gas_internal_timing'/);
  assert.doesNotMatch(performanceLogger, /email|sessionId|customer|content|token|secret/i);
});
