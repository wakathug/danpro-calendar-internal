import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSignedGasRequest } from '../api/_lib/gas-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'gas-internal-api', 'Code.js'), 'utf8');
const signingSecret = 'gas-contract-signing-secret-that-is-long-enough';
const accessSecret = 'gas-contract-access-secret-that-is-long-enough';

function createContext() {
  const cache = new Map();
  let groupLookups = 0;
  const propertyReads = new Map();
  const properties = new Map([
    ['INTERNAL_GAS_SIGNING_SECRET', signingSecret],
    ['ACCESS_POLICY_HMAC_SECRET', accessSecret],
  ]);
  const context = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    Date,
    JSON,
    Math,
    Object,
    Array,
    Number,
    String,
    Set,
    Map,
    RegExp,
    Error,
    Infinity,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(_algorithm, value) {
        return [...crypto.createHash('sha256').update(String(value), 'utf8').digest()];
      },
      computeHmacSha256Signature(value, key) {
        return [...crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest()];
      },
      base64EncodeWebSafe(bytes) {
        return Buffer.from(bytes).toString('base64url');
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            propertyReads.set(key, (propertyReads.get(key) || 0) + 1);
            return properties.get(key) ?? null;
          },
        };
      },
    },
    ScriptApp: {
      getScriptId: () => 'production-script-id',
    },
    CacheService: {
      getScriptCache() {
        return {
          get: (key) => cache.get(key) ?? null,
          put: (key, value) => cache.set(key, value),
          getAll: (keys) => Object.fromEntries(keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)])),
        };
      },
    },
    LockService: {
      getScriptLock() {
        return { tryLock: () => true, releaseLock() {} };
      },
    },
    Drive: {
      Permissions: {
        list() {
          return {
            permissions: [{
              type: 'user',
              role: 'reader',
              emailAddress: 'employee@example.com',
            }],
          };
        },
      },
    },
    GroupsApp: {
      Role: { OWNER: 'OWNER', MANAGER: 'MANAGER', MEMBER: 'MEMBER' },
      getGroupByEmail() {
        groupLookups += 1;
        throw new Error('unexpected group lookup');
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          mimeType: null,
          setMimeType(value) { this.mimeType = value; return this; },
        };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'Code.js' });
  context.getGroupLookups = () => groupLookups;
  context.getPropertyReads = (key) => propertyReads.get(key) || 0;
  return context;
}

test('Apps Script accepts one valid HMAC request and rejects its replay', () => {
  const context = createContext();
  const request = createSignedGasRequest({
    action: 'calendar',
    email: 'employee@example.com',
    body: {},
    now: Date.now(),
    nonce: 'N'.repeat(32),
    secret: signingSecret,
  });
  const parsed = context.parseSignedRequest_({ postData: { contents: JSON.stringify(request) } });
  assert.doesNotThrow(() => context.verifySignedRequest_(parsed));
  assert.throws(() => context.verifySignedRequest_(parsed), /replayed/i);
});

test('Apps Script rejects invalid signature, tampered body, and expired timestamp', () => {
  const invalidContext = createContext();
  const invalid = createSignedGasRequest({
    action: 'calendar',
    email: 'employee@example.com',
    body: {},
    now: Date.now(),
    nonce: 'A'.repeat(32),
    secret: signingSecret,
  });
  invalid.signature = `${invalid.signature.slice(0, -1)}${invalid.signature.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => invalidContext.verifySignedRequest_(invalid), /signature/i);

  const tamperedContext = createContext();
  const tampered = createSignedGasRequest({
    action: 'dayDetails',
    email: 'employee@example.com',
    body: { date: '2026-09-25' },
    now: Date.now(),
    nonce: 'B'.repeat(32),
    secret: signingSecret,
  });
  tampered.body.date = '2026-09-26';
  assert.throws(() => tamperedContext.verifySignedRequest_(tampered), /body hash/i);

  const expiredContext = createContext();
  const expired = createSignedGasRequest({
    action: 'calendar',
    email: 'employee@example.com',
    body: {},
    now: Date.now() - 10 * 60 * 1000,
    nonce: 'C'.repeat(32),
    secret: signingSecret,
  });
  assert.throws(() => expiredContext.verifySignedRequest_(expired), /expired/i);
});

test('direct Apps Script GET reveals no employee data and access hashes use keyed HMAC', () => {
  const context = createContext();
  const output = context.doGet();
  assert.equal(output.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(output.text), { ok: false, error: 'METHOD_NOT_ALLOWED' });
  const digest = context.hashEmail_('employee@example.com', accessSecret);
  const plain = crypto.createHash('sha256').update('employee@example.com').digest('base64url');
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(digest, plain);
});

test('detailed Apps Script timings are exclusive and zero-group policies skip GroupsApp', () => {
  const context = createContext();
  const timing = context.createInternalRequestTiming_(Date.now() - 50);
  const policy = context.buildSpreadsheetAccessPolicy_(accessSecret, timing);
  assert.equal(context.getGroupLookups(), 0);
  assert.equal(timing.groupExpansionMs, 0);
  assert.ok(timing.drivePermissionsReadMs >= 0);
  assert.ok(timing.accessPolicyBuildMs >= 0);
  assert.equal(
    context.isEmailAllowedByPolicy_('employee@example.com', policy.policy, accessSecret),
    true,
  );

  const output = context.createTimedJsonOutput_({ ok: true, data: { authorized: true } }, timing);
  const internal = JSON.parse(output.text).data.internalTiming;
  const exclusiveKeys = [
    'requestParseMs',
    'timestampValidationMs',
    'signingSecretReadMs',
    'bodyDigestMs',
    'hmacComputeMs',
    'signatureCompareMs',
    'nonceLockWaitMs',
    'nonceLookupMs',
    'nonceWriteMs',
    'drivePermissionsReadMs',
    'groupExpansionMs',
    'accessPolicyBuildMs',
    'employeeMembershipMatchMs',
    'calendarAggregateReadMs',
    'dayDetailsCacheReadMs',
    'dayDetailsSpreadsheetOpenMs',
    'dayDetailsSheetResolutionMs',
    'dayDetailsSpreadsheetReadMs',
    'dayDetailsBuildMs',
    'dayDetailsRevisionMs',
    'dayDetailsCacheWriteMs',
    'responseSerializeMs',
  ];
  assert.deepEqual(Object.keys(internal).sort(), [
    ...exclusiveKeys,
    'dayDetailsCacheHit',
    'gasAppTotalMs',
    'gasUnattributedMs',
  ].sort());
  assert.equal(internal.dayDetailsCacheHit, 0);
  const exclusiveTotal = exclusiveKeys.reduce((sum, key) => sum + internal[key], 0);
  assert.equal(internal.gasUnattributedMs, internal.gasAppTotalMs - exclusiveTotal);
  assert.ok(internal.gasUnattributedMs >= 0);
});

test('fresh employee authorization reads the access-policy HMAC secret once per request', () => {
  const context = createContext();
  const timing = context.createInternalRequestTiming_(Date.now());

  assert.doesNotThrow(() => context.verifyEmployeeAccessFresh_('employee@example.com', timing));
  assert.equal(context.getPropertyReads('ACCESS_POLICY_HMAC_SECRET'), 1);
  assert.equal(context.getGroupLookups(), 0);
  assert.ok(timing.accessPolicyBuildMs >= 0);
  assert.ok(timing.employeeMembershipMatchMs >= 0);
});
