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
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.ok(script.indexOf("fetchJson('/api/auth/session')") < script.indexOf('restoreCachedCalendar();'));
  assert.match(script, /if \(!sessionConfirmed\) return false/);
  assert.match(script, /function clearEmployeeState\(\)[\s\S]*clearCachedCalendar\(\)[\s\S]*invalidateDetailCache\(\)/);
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
});

test('new Apps Script project is API-only, HMACs email policy, blocks direct GET, and has no writes', () => {
  const gas = read('gas-internal-api/Code.js');
  assert.match(gas, /function doGet\(\)[\s\S]*METHOD_NOT_ALLOWED/);
  assert.doesNotMatch(gas, /HtmlService/);
  assert.match(gas, /computeHmacSha256Signature\([\s\S]*accessPolicyHmacSecretProperty/);
  assert.match(gas, /consumeNonce_\(request\.nonce\)/);
  assert.match(gas, /signatureClockSkewSeconds: 120/);
  assert.doesNotMatch(gas, /\.setValue\(|\.setValues\(|\.appendRow\(|\.deleteRow\(|\.insertRow/);
});

test('Apps Script manifest grants the scope required by SpreadsheetApp without write code', () => {
  const manifest = JSON.parse(read('gas-internal-api/appsscript.json'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.equal(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'), false);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING',
  });
  const gas = read('gas-internal-api/Code.js');
  assert.doesNotMatch(gas, /\.setValue\(|\.setValues\(|\.appendRow\(|\.deleteRow\(|\.insertRow/);
});

test('Vercel production logging is limited to safe OAuth callback stage codes', () => {
  const callbackPath = path.normalize('auth/callback.js');
  const apiFiles = fs.readdirSync(path.join(root, 'api'), { recursive: true })
    .filter((file) => String(file).endsWith('.js'));
  const callback = read(path.join('api', callbackPath));
  const otherApi = apiFiles
    .filter((file) => path.normalize(String(file)) !== callbackPath)
    .map((file) => read(path.join('api', String(file))))
    .join('\n');
  assert.doesNotMatch(otherApi, /console\.(log|info|warn|error)/);
  assert.equal((callback.match(/console\.error/g) || []).length, 1);
  assert.doesNotMatch(callback, /console\.(log|info|warn)/);
  assert.match(callback, /console\.error\(JSON\.stringify\(\{[\s\S]*?event: 'oauth_callback_failed',[\s\S]*?oauth_callback_stage:[\s\S]*?error_code: safeCode,[\s\S]*?\}\)\)/);
  assert.doesNotMatch(callback, /JSON\.stringify\([^)]*(session|email|customer|content|token|codeVerifier)/i);
});
