import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { productionScriptId, stagingScriptId, verifyTarget } = require('../tools/gas_staging.cjs');
const safeSource = `
  detailCacheTtlSeconds: 75;
  stagingScriptId: '${stagingScriptId}';
  LockService.getUserLock();
`;

test('staging GAS guard rejects the Production Script ID', () => {
  assert.throws(() => verifyTarget({
    scriptId: productionScriptId,
    rootDir: 'gas-internal-api',
  }, 'codex/detail-display-performance', safeSource), /Production/);
});

test('staging GAS guard rejects main and source without concurrency protection', () => {
  const config = { scriptId: stagingScriptId, rootDir: 'gas-internal-api' };
  assert.throws(() => verifyTarget(config, 'main', safeSource), /main branch/);
  assert.throws(() => verifyTarget(
    config,
    'codex/detail-display-performance',
    'detailCacheTtlSeconds: 75;',
  ), /publication lock/);
});

test('staging GAS guard accepts the isolated target on the working branch', () => {
  assert.deepEqual(verifyTarget({
    scriptId: stagingScriptId,
    rootDir: 'gas-internal-api',
  }, 'codex/detail-display-performance', safeSource), {
    scriptId: stagingScriptId,
    branch: 'codex/detail-display-performance',
  });
});

test('staging GAS guard rejects an unknown non-Production Script ID', () => {
  assert.throws(() => verifyTarget({
    scriptId: 'another-script-id',
    rootDir: 'gas-internal-api',
  }, 'codex/detail-display-performance', safeSource), /unrecognized/);
});
