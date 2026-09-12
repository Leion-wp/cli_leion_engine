const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { workspace, fixture, step, shim } = require('./runtime-fixture.cjs');
const { askInput, askChoice, InteractionRequiredError } = require('../packages/cli/out/interaction');
const runner = require('../packages/core/out/pipelineRunner');
const system = require('../packages/core/out/providers/systemAdapter');

test('non-TTY input and choices reject instead of selecting defaults', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  t.after(() => descriptor
    ? Object.defineProperty(process.stdin, 'isTTY', descriptor)
    : delete process.stdin.isTTY);
  await assert.rejects(askInput('Required input', 'pre-approved'), { code: 'INTERACTION_REQUIRED' });
  await assert.rejects(askChoice('Approve?', ['Continue', 'Cancel']), { code: 'INTERACTION_REQUIRED' });
  await assert.rejects(askChoice('Approve?', ['Cancel', 'Continue'], 1), { code: 'INTERACTION_REQUIRED' });
});

test('a host without interaction handlers supplies no implicit human decision', async (t) => {
  fixture(t);
  assert.equal(await shim.window.showQuickPick(['approve', 'reject'], {}), undefined);
  for (const name of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) {
    assert.equal(await shim.window[name]('Approve?', {}, 'Continue', 'Cancel'), undefined);
  }
  await assert.rejects(system.executeSystemCommand({ message: 'Approval required' }), /aborted by user/);
});

test('missing interaction cannot take a retry, continueOnError or graph-loop recovery path', async (t) => {
  const f = fixture(t);
  const attempts = [];
  t.mock.method(shim.commands, 'executeCommand', async (id) => {
    attempts.push(id);
    if (id === 'sentinel.system.pause') throw new InteractionRequiredError('Approval required');
    throw new Error('Downstream provider sentinel must not be called');
  });
  const gate = step('gate', 'system.pause', {}, {
    continueOnError: true, onFailure: 'unsafe', retry: { mode: 'fixed', maxAttempts: 3, delayMs: 1 }
  });
  for (const steps of [
    [gate, step('unsafe', 'terminal.run')],
    [step('loop', 'system.loop', {
      executionMode: 'graph_segment', items: ['a', 'b'], graphStepIds: ['gate'],
      errorStrategy: 'continue', continueOnChildError: true
    }, { onFailure: 'unsafe' }), gate, step('unsafe', 'terminal.run')]
  ]) {
    attempts.length = 0;
    await assert.rejects(runner.runPipelineFromData({ name: 'headless', steps }, false), { code: 'INTERACTION_REQUIRED' });
    assert.deepEqual(attempts, ['sentinel.system.pause']);
  }
  assert.ok(f.events.some((event) => event.type === 'pipelineEnd' && event.status === 'failure'));
});

test('a missing interactive variable fails before provider dispatch or recovery', async (t) => {
  const f = fixture(t);
  const input = t.mock.method(shim.window, 'showInputBox', async () => {
    throw new InteractionRequiredError('Required variable');
  });
  await assert.rejects(runner.runPipelineFromData({ name: 'input-variable', steps: [
    step('needs-input', 'terminal.run', { command: '${input:required}' }, { continueOnError: true, onFailure: 'effect' }),
    step('effect', 'terminal.run')
  ] }, false), { code: 'INTERACTION_REQUIRED' });
  assert.equal(input.mock.callCount(), 1);
  assert.deepEqual(f.invocations, []);
});

function cliFixture(t, steps) {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'pipeline'));
  fs.writeFileSync(path.join(root, 'pipeline', 'proof.intent.json'), JSON.stringify({ name: 'headless-proof', steps }));
  const preload = path.join(root, 'sentinels.cjs');
  const shimPath = require.resolve('../packages/core/out/ports/vscodeShim');
  fs.writeFileSync(preload, `
const shim = require(${JSON.stringify(shimPath)});
const invoke = shim.commands.executeCommand;
shim.commands.executeCommand = async (id, ...args) => {
  if (['intentRouter.internal.systemPause', 'intentRouter.internal.systemSubPipeline', 'intentRouter.internal.systemLoop'].includes(id)) return invoke(id, ...args);
  process.stderr.write('PROVIDER_SENTINEL_CALLED\\n');
  throw new Error('Effectful provider intercepted before invocation');
};
`);
  const cli = path.resolve(__dirname, '../packages/cli/out/index.js');
  return {
    root,
    run: (args) => spawnSync(process.execPath, ['--require', preload, cli, ...args, '--workspace', root], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true
    })
  };
}

test('compiled CLI dry-run succeeds without input or effectful dispatch', (t) => {
  const f = cliFixture(t, [
    step('form', 'system.form', { fields: [{ key: 'approval', type: 'select', options: ['approve', 'reject'] }] }),
    step('pause', 'system.pause', { message: 'No approval should be requested during preview' }),
    step('provider', 'terminal.run', { command: '${input:never prompt}' }),
    step('child', 'system.subPipeline', { pipelinePath: 'not-opened.intent.json', dryRunChild: false })
  ]);
  const result = f.run(['run_pipeline', '--pipeline', 'proof', '--dry_run', '--json', '--verbose']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'success');
  assert.doesNotMatch(result.stderr, /PROVIDER_SENTINEL_CALLED|INTERACTION_REQUIRED/);
});

test('compiled CLI refuses a headless approval even with recovery configured', (t) => {
  const f = cliFixture(t, [
    step('approval', 'system.pause', { message: 'Approve action' }, {
      continueOnError: true, onFailure: 'effect', retry: { mode: 'fixed', maxAttempts: 3, delayMs: 1 }
    }),
    step('effect', 'terminal.run', { command: 'must-never-execute' })
  ]);
  const result = f.run(['run_pipeline', '--pipeline', 'proof', '--json']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INTERACTION_REQUIRED/);
  assert.doesNotMatch(result.stderr, /PROVIDER_SENTINEL_CALLED/);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'INTERACTION_REQUIRED');
});

test('compiled CLI refuses required form text, select and checkbox fields without TTY', (t) => {
  for (const type of ['text', 'select', 'checkbox']) {
    const f = cliFixture(t, [step('form', 'system.form', { fields: [
      { key: 'approval', type, required: true, default: 'approved', options: ['approve', 'reject'] }
    ] }), step('effect', 'terminal.run')]);
    const result = f.run(['run_pipeline', '--pipeline', 'proof']);
    assert.equal(result.status, 1, type);
    assert.match(result.stderr, /INTERACTION_REQUIRED/, type);
    assert.doesNotMatch(result.stderr, /PROVIDER_SENTINEL_CALLED/, type);
  }
});

test('headless interaction failure crosses child pipelines and child-loop recovery policies', (t) => {
  for (const intent of ['system.subPipeline', 'system.loop']) {
    const f = cliFixture(t, [step('child', intent, {
      pipelinePath: 'child.intent.json', items: ['a', 'b'], continueOnChildError: true, errorStrategy: 'continue'
    }, { continueOnError: true, onFailure: 'effect' }), step('effect', 'terminal.run')]);
    fs.writeFileSync(path.join(f.root, 'child.intent.json'), JSON.stringify({ name: 'child', steps: [
      step('approval', 'system.pause', { message: 'Approve child' })
    ] }));
    const result = f.run(['run_pipeline', '--pipeline', 'proof']);
    assert.equal(result.status, 1, `${intent}: ${result.stderr}`);
    assert.match(result.stderr, /INTERACTION_REQUIRED/);
    assert.doesNotMatch(result.stderr, /PROVIDER_SENTINEL_CALLED/);
  }
});

test('worker entry point persists an explicit headless-interaction failure', (t) => {
  const f = cliFixture(t, [step('approval', 'system.pause', { message: 'Approve worker' }), step('effect', 'terminal.run')]);
  const result = f.run(['__worker_run', '--pipeline', 'proof', '--run_id', 'worker-test']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /PROVIDER_SENTINEL_CALLED/);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '.intent-router', 'runs', 'worker-test.json'), 'utf8'));
  assert.equal(state.status, 'failure');
  assert.match(state.error, /INTERACTION_REQUIRED/);
});
