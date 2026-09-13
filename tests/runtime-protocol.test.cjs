const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { workspace, step } = require('./runtime-fixture.cjs');
const { getRuntimeCapabilities, describeRuntime, PROTOCOL_COMMANDS } = require('../packages/core/out/runtimeCatalog');
const { validatePipelineData } = require('../packages/core/out/validatePipeline');
const { resolvePipelineSourcePath } = require('../packages/core/out/pipelineSource');
const registry = require('../packages/core/out/registry');
const { builtinCapabilityRegistrations } = require('../packages/core/out/builtinCapabilities');

function cli(t, { pipelineDirectory = true } = {}) {
  const root = workspace(t);
  if (pipelineDirectory) fs.mkdirSync(path.join(root, 'pipeline'));
  const preload = path.join(root, 'static-sentinels.cjs');
  const corePath = require.resolve('../packages/core/out/coreRuntime');
  const runnerPath = require.resolve('../packages/core/out/pipelineRunner');
  const shimPath = require.resolve('../packages/core/out/ports/vscodeShim');
  fs.writeFileSync(preload, `
const fail = () => { throw new Error('STATIC_EFFECT_SENTINEL'); };
require(${JSON.stringify(corePath)}).CoreRuntime = class { constructor() { fail(); } };
require(${JSON.stringify(runnerPath)}).runPipelineFromData = fail;
require(${JSON.stringify(shimPath)}).commands.executeCommand = fail;
const fs = require('node:fs');
for (const name of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','renameSync','rmSync']) fs[name] = fail;
for (const name of ['writeFile','appendFile','mkdir','unlink','rename','rm']) fs.promises[name] = fail;
const cp = require('node:child_process');
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name] = fail;
global.fetch = fail;
`);
  const entry = path.resolve(__dirname, '../packages/cli/out/index.js');
  return {
    root,
    write: (data, name = 'proof.intent.json') => {
      const target = path.join(root, 'pipeline', name);
      fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
      return target;
    },
    run: (args, expectedStatus = 0) => {
      const result = spawnSync(process.execPath, ['--require', preload, entry, ...args, '--workspace', root, '--json'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus, `${result.stderr}\n${result.stdout}`);
      assert.doesNotMatch(result.stderr, /STATIC_EFFECT_SENTINEL/);
      const json = JSON.parse(result.stdout); // Exactly one document: no prefix/suffix workaround.
      assert.equal(json.protocolVersion, '1');
      return { json, stderr: result.stderr };
    }
  };
}

const validPipeline = () => ({ name: 'static-proof', intent: 'pipeline.run', steps: [
  step('label', 'system.setVar', { name: 'label', value: 'proof' }),
  step('terminal', 'terminal.run', { command: 'THIS_MUST_NOT_BE_EXECUTED', __sandbox: { allowNetwork: false, allowFileWrite: false } })
] });

test('catalog preserves shared registration descriptors and exposes conservative host facts', () => {
  registry.resetRegistry();
  for (const registration of builtinCapabilityRegistrations) registry.registerCapabilities(registration);
  const catalog = getRuntimeCapabilities();
  const registered = registry.listPublicCapabilities();
  assert.equal(catalog.length, registered.length + 1); // pipeline.run is runner/router-owned.
  for (const original of registered) {
    const descriptor = catalog.find((entry) => entry.capability === original.capability);
    for (const key of ['capability', 'provider', 'command', 'type', 'determinism']) assert.equal(descriptor[key], original[key]);
    assert.deepEqual(descriptor.args.map(({ acceptedTypes, ...arg }) => arg), original.args || []);
    assert.equal(descriptor.capabilityType, original.capabilityType || 'atomic');
    for (const key of ['host', 'executionMode', 'risk', 'requirements', 'available']) assert.notEqual(descriptor[key], undefined);
    assert.equal('mapPayload' in descriptor, false);
  }
  assert.equal(catalog.find((entry) => entry.capability === 'git.clone').available, false);
  assert.equal(catalog.find((entry) => entry.capability === 'terminal.run').available, 'unknown');
  assert.equal(catalog.find((entry) => entry.capability === 'git.commit').executionMode, 'pipeline-compiled-terminal');
  assert.deepEqual(catalog.find((entry) => entry.capability === 'system.form').args[0].acceptedTypes, ['array']);
  catalog.find((entry) => entry.capability === 'terminal.run').args[0].required = false;
  assert.equal(getRuntimeCapabilities().find((entry) => entry.capability === 'terminal.run').args[0].required, true);
  const envelope = describeRuntime('fixture-version');
  assert.equal(envelope.runtime.version, 'fixture-version');
  assert.deepEqual(envelope.runtime.capabilities, PROTOCOL_COMMANDS);
  assert.deepEqual(envelope.runtime.contracts.pipeline_inputs, {
    version: '1',
    authorRoot: 'pipeline',
    approvedBundleRoot: '.leiok/execution-bundles',
    absolutePathPolicy: 'allowed_roots_only',
    regularFileRequired: true,
    redirectedAncestors: 'confined_to_workspace',
    validationExecutionParity: true,
    approvedBundleFilenameSha256: true
  });
  assert.equal(envelope.runtime.contracts.run_logs.cursorFormat, 'lr1');
  assert.equal(envelope.runtime.contracts.run_logs.eventVersion, 1);
  assert.deepEqual(envelope.runtime.contracts.run_controls, {
    version: '1',
    idempotent: true,
    pauseRequestedState: 'pause_requested',
    pauseAcknowledgedState: 'paused',
    resumePendingState: 'paused',
    resumeAcknowledgedState: 'running',
    cancelRequestedState: 'cancel_requested',
    cancelTerminalState: 'cancelled',
    cancellationDominant: true,
    terminalProcessExitRequired: true
  });
  assert.deepEqual(envelope.runtime.contracts.run_logs.limits, {
    default: 100,
    max: 200,
    maxRecordBytes: 16384,
    maxResponseBytes: 524288,
    maxScanBytes: 8388608
  });
});

test('describe and catalog return directly parsable protocol JSON without runtime construction or writes', (t) => {
  const f = cli(t, { pipelineDirectory: false });
  const describe = f.run(['runtime_describe']).json;
  const catalog = f.run(['catalog', '--section', 'capabilities', '--verbose']).json;
  assert.deepEqual(catalog, describe);
  assert.equal(describe.ok, true);
  assert.equal(describe.runtime.name, 'leion-roots');
  assert.equal(describe.runtime.version, require('../packages/cli/package.json').version);
  assert.ok(describe.capabilities.length > 20);
  assert.equal(fs.existsSync(path.join(f.root, 'pipeline')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.intent-router')), false);
});

test('validation reads a named, relative or absolute in-pipeline file without any execution', (t) => {
  const f = cli(t);
  const file = f.write(validPipeline());
  const canonicalFile = fs.realpathSync.native(file);
  const before = fs.readFileSync(file, 'utf8');
  for (const reference of ['proof', 'pipeline/proof.intent.json', file]) {
    const { json } = f.run(['validate_pipeline', '--pipeline', reference]);
    assert.equal(json.ok, true);
    assert.equal(json.valid, true);
    assert.equal(json.steps, 2);
    assert.equal(json.path, canonicalFile);
    assert.deepEqual(json.diagnostics, []);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'pipeline')), ['proof.intent.json']);
  assert.equal(fs.existsSync(path.join(f.root, '.intent-router')), false);
  assert.equal(resolvePipelineSourcePath(f.root, canonicalFile), canonicalFile);
});

test('validation accepts only canonical approved control-plane bundle paths', (t) => {
  const f = cli(t);
  const planId = 'plan_approved-1';
  const serialized = JSON.stringify(validPipeline());
  const revision = require('node:crypto').createHash('sha256').update(serialized).digest('hex');
  const bundleDir = path.join(f.root, '.leiok', 'execution-bundles', planId);
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundle = path.join(bundleDir, `${revision}.intent.json`);
  fs.writeFileSync(bundle, serialized);

  for (const reference of [
    `.leiok/execution-bundles/${planId}/${revision}.intent.json`,
    bundle
  ]) {
    const { json } = f.run(['validate_pipeline', '--pipeline', reference]);
    assert.equal(json.ok, true);
    assert.equal(json.valid, true);
    assert.equal(json.path, fs.realpathSync.native(bundle));
  }

  fs.writeFileSync(bundle, JSON.stringify({ ...validPipeline(), name: 'tampered-after-publication' }));
  const { json: tampered } = f.run(['validate_pipeline', '--pipeline', bundle], 1);
  assert.equal(tampered.diagnostics[0].code, 'PIPELINE_HASH_MISMATCH');

  const arbitraryDir = path.join(f.root, '.leiok', 'other');
  fs.mkdirSync(arbitraryDir, { recursive: true });
  const arbitrary = path.join(arbitraryDir, 'private.intent.json');
  fs.writeFileSync(arbitrary, JSON.stringify(validPipeline()));
  for (const reference of [
    arbitrary,
    `.leiok/execution-bundles/${planId}/not-a-hash.intent.json`,
    `.leiok/execution-bundles/nested/plan/${revision}.intent.json`,
    `.leiok/execution-bundles/${revision}.intent.json`,
    `.leiok/execution-bundles/plan:nonportable/${revision}.intent.json`,
    `.leiok/execution-bundles/CON/${revision}.intent.json`,
    `.leiok/execution-bundles/trailing./${revision}.intent.json`
  ]) {
    const { json } = f.run(['validate_pipeline', '--pipeline', reference], 1);
    assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_PIPELINE');
  }
});

test('validation rejects an approved bundle junction escape before reading', (t) => {
  const f = cli(t);
  const outside = workspace(t);
  const revision = 'b'.repeat(64);
  fs.writeFileSync(path.join(outside, `${revision}.intent.json`), 'BUNDLE_SECRET_MUST_NOT_APPEAR');
  const bundleRoot = path.join(f.root, '.leiok', 'execution-bundles');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(bundleRoot, 'plan_escape'), process.platform === 'win32' ? 'junction' : 'dir');

  const { json } = f.run([
    'validate_pipeline',
    '--pipeline',
    `.leiok/execution-bundles/plan_escape/${revision}.intent.json`
  ], 1);
  assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_PIPELINE');
  assert.doesNotMatch(JSON.stringify(json), /BUNDLE_SECRET_MUST_NOT_APPEAR/);
});

test('an approved bundle root redirected outside the workspace is rejected', (t) => {
  const f = cli(t);
  const outside = workspace(t);
  const revision = 'c'.repeat(64);
  const outsidePlan = path.join(outside, 'plan_external');
  fs.mkdirSync(outsidePlan, { recursive: true });
  fs.writeFileSync(path.join(outsidePlan, `${revision}.intent.json`), JSON.stringify(validPipeline()));
  const leiokRoot = path.join(f.root, '.leiok');
  fs.mkdirSync(leiokRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(leiokRoot, 'execution-bundles'), process.platform === 'win32' ? 'junction' : 'dir');

  const { json } = f.run([
    'validate_pipeline',
    '--pipeline',
    `.leiok/execution-bundles/plan_external/${revision}.intent.json`
  ], 1);
  assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_WORKSPACE');
});

test('attached execution rejects a pipeline path outside both source roots before runtime construction', (t) => {
  const f = cli(t);
  const outside = path.join(f.root, 'outside.intent.json');
  fs.writeFileSync(outside, JSON.stringify(validPipeline()));

  const { json } = f.run(['run_pipeline', '--pipeline', outside, '--dry_run'], 1);
  assert.equal(json.ok, false);
  assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_PIPELINE');
});

test('invalid structure, IDs, capabilities, required args and basic types return localized JSON diagnostics', (t) => {
  const f = cli(t);
  f.write({ name: 'invalid', steps: [
    step('same', 'terminal.run', { command: 123 }),
    step('same', 'http.request', { method: 'NOT_HTTP' }),
    step('unknown', 'invented.provider', {}, { capabilities: ['invented.override'] }),
    step('   ', 'system.setVar', { name: 'x' }),
    step('clone', 'git.clone', { url: 'never-execute' }),
    step('boolean', 'docker.run', { image: 'none', detach: 'false' }),
    step('payload', 'terminal.run', [])
  ] });
  const { json } = f.run(['validate_pipeline', '--pipeline', 'proof'], 1);
  assert.equal(json.valid, false);
  const codes = new Set(json.diagnostics.map((entry) => entry.code));
  for (const code of ['DUPLICATE_STEP_ID', 'UNKNOWN_INTENT', 'REQUIRED_ARGUMENT', 'INVALID_STEP_ID', 'UNAVAILABLE_INTENT', 'ARGUMENT_TYPE', 'ARGUMENT_ENUM', 'INVALID_PAYLOAD']) assert.ok(codes.has(code), code);
  assert.ok(json.diagnostics.some((entry) => entry.path === '/steps/0/payload/command' && entry.stepId === 'same'));
  assert.ok(json.diagnostics.every((entry) => entry.file === json.path));
});

test('all control-flow references must resolve and graph loops use their actual array contract', () => {
  const result = validatePipelineData({ name: 'targets', steps: [
    step('switch', 'system.switch', { variableKey: 'pick', defaultStepId: 'missing-default', routes: [
      { value: 'x', targetStepId: 'missing-route' }, null
    ] }, { onFailure: 'missing-failure' }),
    step('loop', 'system.loop', { executionMode: 'graph_segment', items: ['x'], graphStepIds: ['missing-body', 'loop'], doneStepId: 'missing-done' })
  ] });
  assert.equal(result.valid, false);
  for (const location of ['/steps/0/onFailure', '/steps/0/payload/defaultStepId', '/steps/0/payload/routes/0/targetStepId', '/steps/1/payload/graphStepIds/0', '/steps/1/payload/doneStepId']) {
    assert.ok(result.diagnostics.some((entry) => entry.path === location && entry.code === 'UNKNOWN_TARGET'), location);
  }
  assert.ok(result.diagnostics.some((entry) => entry.code === 'LOOP_SELF_REFERENCE'));
  const valid = validatePipelineData({ name: 'graph', steps: [
    step('loop', 'system.loop', { executionMode: 'graph_segment', items: ['x'], graphStepIds: ['body'] }),
    step('body', 'terminal.run', { command: 'sentinel' })
  ] });
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
});

test('inline composites are checked recursively and runtime templates are explicitly deferred', () => {
  const result = validatePipelineData({ name: 'composite', steps: [
    step('parent', 'pipeline.run', {}, { steps: [
      step('child', 'terminal.run', { command: '${var:command}' }),
      step('child', 'http.request')
    ] })
  ] });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === 'DUPLICATE_STEP_ID' && entry.path === '/steps/0/steps/1/id'));
  assert.ok(result.diagnostics.some((entry) => entry.code === 'DYNAMIC_ARGUMENT' && entry.severity === 'warning'));
  assert.equal(validatePipelineData({ name: 'empty', steps: [] }).valid, false);
  assert.equal(validatePipelineData(null).valid, false);
  assert.equal(validatePipelineData({ name: 'null-type', steps: [step('terminal', 'terminal.run', { command: 'sentinel', cwd: null })] }).valid, false);
});

test('capability overrides cannot bypass required argument validation', () => {
  const result = validatePipelineData({ name: 'override', steps: [
    step('override', 'terminal.run', { command: 'sentinel' }, { capabilities: ['github.openPr'] })
  ] });
  assert.equal(result.valid, false);
  for (const argument of ['head', 'base', 'title']) {
    assert.ok(result.diagnostics.some((entry) => entry.code === 'REQUIRED_ARGUMENT' && entry.path.endsWith(`/payload/${argument}`)));
  }
});

test('invalid JSON, missing paths/flags and unsupported sections retain single-document error responses', (t) => {
  const f = cli(t);
  f.write('{ broken JSON');
  for (const [args, code] of [
    [['validate_pipeline', '--pipeline', 'proof'], 'INVALID_JSON'],
    [['validate_pipeline', '--pipeline', 'missing'], 'PATH_UNAVAILABLE'],
    [['validate_pipeline'], 'PIPELINE_REQUIRED'],
    [['validate_pipeline', '--pipeline'], 'PIPELINE_REQUIRED'],
    [['catalog', '--section', 'made-up'], 'UNSUPPORTED_SECTION'],
    [['made-up-command'], 'COMMAND_FAILED']
  ]) {
    const { json } = f.run(args, 1);
    assert.equal(json.ok, false);
    assert.ok(json.diagnostics.some((entry) => entry.code === code), `${code}: ${JSON.stringify(json)}`);
  }
});

test('validation rejects traversal, workspace-root files and symlink/junction escapes before reading', (t) => {
  const f = cli(t);
  const outside = workspace(t);
  const outsideFile = path.join(outside, 'private.intent.json');
  fs.writeFileSync(outsideFile, 'SECRET_CONTENT_MUST_NOT_APPEAR');
  fs.writeFileSync(path.join(f.root, 'outside.intent.json'), 'SECRET_CONTENT_MUST_NOT_APPEAR');
  for (const reference of ['../outside', 'pipeline/../outside', 'pipeline\\..\\outside', outsideFile, path.join(f.root, 'outside.intent.json')]) {
    const { json } = f.run(['validate_pipeline', '--pipeline', reference], 1);
    assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_PIPELINE');
    assert.doesNotMatch(JSON.stringify(json), /SECRET_CONTENT_MUST_NOT_APPEAR/);
  }
  fs.symlinkSync(outside, path.join(f.root, 'pipeline', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const { json } = f.run(['validate_pipeline', '--pipeline', 'pipeline/escape/private.intent.json'], 1);
  assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_PIPELINE');
});

test('a pipeline directory pointing outside the workspace is rejected', (t) => {
  const f = cli(t, { pipelineDirectory: false });
  const outside = workspace(t);
  fs.writeFileSync(path.join(outside, 'private.intent.json'), JSON.stringify(validPipeline()));
  fs.symlinkSync(outside, path.join(f.root, 'pipeline'), process.platform === 'win32' ? 'junction' : 'dir');
  const { json } = f.run(['validate_pipeline', '--pipeline', 'private'], 1);
  assert.equal(json.diagnostics[0].code, 'PATH_OUTSIDE_WORKSPACE');
});
