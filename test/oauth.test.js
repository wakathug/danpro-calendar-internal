import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { createAuthFlow, consumeAuthFlow, OAUTH_COOKIE } from '../api/_lib/auth-flow.js';
import { createPkcePair } from '../api/_lib/crypto.js';
import {
  exchangeAuthorizationCode,
  GOOGLE_ISSUER,
  validateGoogleClaims,
  verifyGoogleIdToken,
} from '../api/_lib/oauth.js';
import callbackHandler from '../api/auth/callback.js';
import {
  configureTestEnvironment,
  MemoryStore,
  mockRequest,
  mockResponse,
} from './helpers.js';

configureTestEnvironment();

test.beforeEach(() => {
  globalThis.__DANPRO_TEST_STORE__ = new MemoryStore();
});

test.afterEach(() => {
  delete globalThis.__DANPRO_TEST_STORE__;
  delete globalThis.fetch;
});

test('OAuth state is browser-bound, one-time, and mismatch is rejected', async () => {
  const flow = await createAuthFlow(1_000_000);
  const binding = /__Host-danpro_oauth=([^;]+)/.exec(flow.cookie)[1];
  const wrong = await consumeAuthFlow(mockRequest({ headers: { cookie: `${OAUTH_COOKIE}=wrong-binding-value-that-is-long` } }), flow.state, 1_000_100);
  assert.equal(wrong, null);

  const secondFlow = await createAuthFlow(2_000_000);
  const secondBinding = /__Host-danpro_oauth=([^;]+)/.exec(secondFlow.cookie)[1];
  const request = mockRequest({ headers: { cookie: `${OAUTH_COOKIE}=${secondBinding}` } });
  assert.ok(await consumeAuthFlow(request, secondFlow.state, 2_000_100));
  assert.equal(await consumeAuthFlow(request, secondFlow.state, 2_000_200), null);

  const response = mockResponse();
  await callbackHandler(mockRequest({ query: { state: 'invalid', code: 'valid-code-value' } }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'INVALID_OAUTH_STATE');
});

test('PKCE uses S256 and a failed verifier exchange is rejected', async () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  let posted;
  globalThis.fetch = async (_url, options) => {
    posted = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(() => exchangeAuthorizationCode('valid-auth-code', 'wrong-verifier'));
  assert.equal(posted.get('code_verifier'), 'wrong-verifier');
  assert.equal(posted.get('grant_type'), 'authorization_code');
});

test('OIDC claim validation rejects nonce, issuer, audience, expiry, and unverified email', () => {
  const now = 2_000_000_000_000;
  const base = {
    iss: GOOGLE_ISSUER,
    aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
    exp: Math.floor(now / 1000) + 300,
    iat: Math.floor(now / 1000) - 10,
    nonce: 'expected-nonce',
    email: 'Employee@Example.com',
    email_verified: true,
    sub: 'subject-1',
  };
  assert.equal(validateGoogleClaims(base, 'expected-nonce', base.aud, now).email, 'employee@example.com');
  assert.throws(() => validateGoogleClaims({ ...base, nonce: 'wrong' }, 'expected-nonce', base.aud, now), /nonce/i);
  assert.throws(() => validateGoogleClaims({ ...base, iss: 'https://evil.example' }, 'expected-nonce', base.aud, now), /issuer/i);
  assert.throws(() => validateGoogleClaims({ ...base, aud: 'other-client' }, 'expected-nonce', base.aud, now), /audience/i);
  assert.throws(() => validateGoogleClaims({ ...base, exp: Math.floor(now / 1000) - 1 }, 'expected-nonce', base.aud, now), /expired/i);
  assert.throws(() => validateGoogleClaims({ ...base, email_verified: false }, 'expected-nonce', base.aud, now), /unverified/i);
});

test('Google ID token with an invalid signature is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const signer = await generateKeyPair('RS256');
  const verifier = await generateKeyPair('RS256');
  const signerJwk = await exportJWK(signer.publicKey);
  const verifierJwk = await exportJWK(verifier.publicKey);
  signerJwk.kid = 'signer';
  verifierJwk.kid = 'signer';
  const token = await new SignJWT({
    nonce: 'nonce-value',
    email: 'employee@example.com',
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'signer' })
    .setIssuer(GOOGLE_ISSUER)
    .setAudience(process.env.GOOGLE_OAUTH_CLIENT_ID)
    .setSubject('subject')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signer.privateKey);
  const wrongKeySet = createLocalJWKSet({ keys: [verifierJwk] });
  await assert.rejects(() => verifyGoogleIdToken(token, 'nonce-value', { keySet: wrongKeySet }));
});

