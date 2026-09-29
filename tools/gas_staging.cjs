'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const productionScriptId = '1OArfK6S2oaQAAsfz97aIJtYgrsofrhkGLChM2Pn05f6zSEqgvUQ_ain5';
const stagingScriptId = '1cQSSPk0RJzPC4oI9Yl3SZFLqOnxAm-XNmdVFD9y8flhIoZW7VDBmSWQG';
const stagingProjectFile = path.join(root, '.clasp.staging.json');
const stagingBootstrapProjectFile = path.join(root, '.clasp.staging-bootstrap.json');
const allowedCommands = new Set([
  'verify',
  'status',
  'push',
  'version',
  'deploy',
  'deployments',
  'bootstrap-status',
  'bootstrap-push',
  'bootstrap-version',
  'bootstrap-deploy',
  'bootstrap-run',
]);

function verifyTarget(config, branch, source) {
  if (!config || typeof config.scriptId !== 'string' || !config.scriptId.trim()) {
    throw new Error('staging Script ID is not configured');
  }
  if (config.scriptId === productionScriptId) {
    throw new Error('refusing to target the Production Apps Script project');
  }
  if (config.scriptId !== stagingScriptId) {
    throw new Error('refusing an unrecognized Apps Script staging target');
  }
  if (config.rootDir !== 'gas-internal-api') {
    throw new Error('staging rootDir must be gas-internal-api');
  }
  if (!branch || branch === 'main' || branch === 'master') {
    throw new Error('refusing staging mutation from the main branch');
  }
  if (!/detailCacheTtlSeconds:\s*75/.test(source)) {
    throw new Error('staging source must keep the 75-second detail cache TTL');
  }
  if (!/LockService\.getUserLock\(\)/.test(source)) {
    throw new Error('staging source is missing the dedicated publication lock');
  }
  if (!source.includes(`stagingScriptId: '${stagingScriptId}'`)) {
    throw new Error('staging source is missing its runtime data-source guard');
  }
  return { scriptId: config.scriptId, branch };
}

function readVerifiedTarget(projectFile = stagingProjectFile, bootstrap = false) {
  const config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (branchResult.status !== 0) throw new Error('unable to determine the current Git branch');
  if (bootstrap) {
    if (config.scriptId === productionScriptId) {
      throw new Error('refusing to target the Production Apps Script project');
    }
    if (config.scriptId !== stagingScriptId) {
      throw new Error('refusing an unrecognized Apps Script staging target');
    }
    if (config.rootDir !== 'gas-internal-api-staging-bootstrap') {
      throw new Error('staging bootstrap rootDir is invalid');
    }
    const finalConfig = JSON.parse(fs.readFileSync(stagingProjectFile, 'utf8'));
    if (config.scriptId !== finalConfig.scriptId) {
      throw new Error('bootstrap and final staging Script IDs differ');
    }
    const source = fs.readFileSync(
      path.join(root, 'gas-internal-api-staging-bootstrap', 'Code.js'),
      'utf8',
    );
    if (/newTrigger\s*\(/.test(source) || !/getProjectTriggers\(\)\.length !== 0/.test(source)) {
      throw new Error('bootstrap source does not enforce the no-trigger invariant');
    }
    if (source.includes('1KOHReFlDdmJvLWX16Qram6TSogWMXwW4ddWRI6uWjfY')) {
      throw new Error('bootstrap source must not reference the Production Spreadsheet');
    }
    return { scriptId: config.scriptId, branch: branchResult.stdout.trim() };
  }
  const source = fs.readFileSync(path.join(root, 'gas-internal-api', 'Code.js'), 'utf8');
  return verifyTarget(config, branchResult.stdout.trim(), source);
}

function run() {
  const command = process.argv[2] || 'verify';
  if (!allowedCommands.has(command)) throw new Error(`unsupported staging command: ${command}`);
  const bootstrap = command.startsWith('bootstrap-');
  const projectFile = bootstrap ? stagingBootstrapProjectFile : stagingProjectFile;
  const claspSubcommand = bootstrap ? command.slice('bootstrap-'.length) : command;
  const target = readVerifiedTarget(projectFile, bootstrap);
  process.stdout.write(`verified staging Apps Script target ${target.scriptId}\n`);
  if (command === 'verify') return;

  const claspCommand = process.platform === 'win32' ? 'clasp.cmd' : 'clasp';
  const claspArgs = ['--project', projectFile, '--user', 'danpro', claspSubcommand];
  if (claspSubcommand === 'push') claspArgs.push('--force');
  claspArgs.push(...process.argv.slice(3));
  const result = spawnSync(claspCommand, claspArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { productionScriptId, stagingScriptId, verifyTarget };
