const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { fixture, step, shim, registry } = require('./runtime-fixture.cjs');
const runner = require('../packages/core/out/pipelineRunner');
const router = require('../packages/core/out/router');
const memory = require('../packages/core/out/runMemoryStore');
const system = require('../packages/core/out/providers/systemAdapter');

test('dry-run prevents all provider, payload mapper, input and memory calls', async (t) => {
  const f = fixture(t);
  const input = t.mock.method(shim.window, 'showInputBox', async () => {
    throw new Error('Input sentinel must not be called');
  });
  const select = t.mock.method(shim.window, 'showQuickPick', async () => {
    throw new Error('Choice sentinel must not be called');
  });
  const memoryCalls = ['saveRunMemory', 'queryRunMemory', 'clearRunMemory'].map((key) =>
    t.mock.method(memory, key, () => { throw new Error(`Memory sentinel called: ${key}`); }));
  const seen = [];
  const originalRoute = router.routeIntent;
  t.mock.method(router, 'routeIntent', async (intent, variables) => {
    seen.push(intent);
    return originalRoute(intent, variables);
  });

  const result = await runner.runPipelineFromData({ name: 'preview', steps: [
    step('form', 'system.form', { fields: [{ key: 'approval', type: 'select', options: ['approve', 'reject'] }] }),
    step('terminal', 'terminal.run', { command: '${input:never prompt}' }, { meta: { dryRun: false } }),
    step('network', 'http.request', { url: 'https://sentinel.invalid' }),
    step('ai', 'ai.generate'),
    step('github', 'github.openPr'),
    step('git', 'git.checkout', { branch: 'preview' }),
    step('docker', 'docker.run', { image: 'preview' }),
    step('child', 'system.subPipeline', { pipelinePath: 'missing.intent.json', dryRunChild: false }),
    step('loop-child', 'system.loop', { pipelinePath: 'missing.intent.json', items: ['a'], dryRunChild: false }),
    step('pause', 'system.pause', { message: 'Do not approve' }),
    step('save', 'memory.save', { sessionId: 'sentinel', data: 'do not write' }),
    step('recall', 'memory.recall', { sessionId: 'sentinel' }),
    step('clear', 'memory.clear', { sessionId: 'sentinel' }),
    step('composite', 'pipeline.run', {}, { steps: [
      step('nested-http', 'http.request', {}, { meta: { dryRun: false } }),
      step('nested-composite', 'pipeline.run', {}, { meta: { dryRun: false }, steps: [
        step('nested-terminal', 'terminal.run', {}, { meta: { dryRun: false } })
      ] })
    ] })
  ] }, true);

  assert.equal(result.status, 'success');
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.mappings, []);
  assert.equal(input.mock.callCount(), 0);
  assert.equal(select.mock.callCount(), 0);
  for (const sentinel of memoryCalls) assert.equal(sentinel.mock.callCount(), 0);
  assert.ok(seen.length >= 10);
  assert.ok(seen.every((intent) => intent.meta.dryRun === true));
  assert.ok(f.events.some((event) => event.type === 'stepLog' && event.text.includes('[dry-run]')));
  assert.equal(fs.existsSync(path.join(f.root, '.intent-router', 'run-memory-v2.json')), false);
});

test('composite children cannot turn off a direct route_intent dry-run', async (t) => {
  const f = fixture(t);
  assert.equal(await router.routeIntent({ intent: 'pipeline.run', meta: { dryRun: true }, steps: [
    step('child', 'terminal.run', {}, { meta: { dryRun: false } })
  ] }), true);
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.mappings, []);
});

test('preview does not invent provider output variables used by later branches', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({ name: 'outputs', steps: [
    step('seed', 'system.setVar', { name: 'captured', value: 'fixture' }),
    step('provider', 'terminal.run', { outputVar: 'captured' }),
    step('switch', 'system.switch', { variableKey: 'captured', routes: [
      { condition: 'equals', value: 'fixture', targetStepId: 'expected' }
    ], defaultStepId: 'fabricated' }),
    step('fabricated', 'terminal.run'),
    step('expected', 'terminal.run')
  ] }, true);
  assert.equal(result.success, true);
  assert.equal(f.events.some((event) => event.type === 'stepStart' && event.stepId === 'fabricated'), false);
  assert.deepEqual(f.invocations, []);
});

test('switch branches and graph-segment loop targets inherit preview', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({ name: 'branches', steps: [
    step('choose', 'system.setVar', { name: 'branch', value: 'loop' }),
    step('switch', 'system.switch', { variableKey: 'branch', routes: [
      { condition: 'equals', value: 'loop', targetStepId: 'loop' }
    ], defaultStepId: 'unselected' }),
    step('unselected', 'terminal.run'),
    step('loop', 'system.loop', {
      executionMode: 'graph_segment', items: ['a', 'b'], graphStepIds: ['target'], doneStepId: 'done'
    }),
    step('target', 'http.request', {}, { meta: { dryRun: false } }),
    step('done', 'terminal.run')
  ] }, true);
  assert.equal(result.status, 'success');
  assert.deepEqual(f.invocations, []);
  assert.ok(f.events.filter((event) => event.type === 'stepLog' && /item=.*step=target/.test(event.text)).length === 2);
  assert.equal(f.events.some((event) => event.type === 'stepStart' && event.stepId === 'unselected'), false);
});

test('failure branches stay in preview even when sandbox checks fail', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({ name: 'failure-route', steps: [
    step('blocked', 'http.request', { __sandbox: { allowNetwork: false } }, { onFailure: 'recovery' }),
    step('recovery', 'terminal.run', {}, { meta: { dryRun: false } })
  ] }, true);
  assert.equal(result.status, 'success');
  assert.deepEqual(f.invocations, []);
  assert.ok(f.events.some((event) => event.type === 'stepStart' && event.stepId === 'recovery'));
});

test('step and pipeline metadata can opt into dry-run without disabling live sentinels', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({ name: 'mixed', steps: [
    step('preview', 'terminal.run', {}, { meta: { dryRun: true } }),
    step('live-sentinel', 'terminal.run')
  ] }, false);
  assert.equal(result.status, 'success');
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].args[0].__meta.stepId, 'live-sentinel');
  f.invocations.length = 0;
  assert.equal((await runner.runPipelineFromData({ name: 'metadata', meta: { dryRun: true }, steps: [
    step('preview', 'terminal.run', {}, { meta: { dryRun: false } })
  ] }, false)).success, true);
  assert.deepEqual(f.invocations, []);
});

test('a preview-only graph loop cannot reactivate its target', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({ name: 'loop-metadata', steps: [
    step('loop', 'system.loop', {
      executionMode: 'graph_segment', items: ['a'], graphStepIds: ['target'], doneStepId: 'done'
    }, { meta: { dryRun: true } }),
    step('target', 'terminal.run', {}, { meta: { dryRun: false } }),
    step('done', 'system.setVar', { name: 'done', value: 'yes' })
  ] }, false);
  assert.equal(result.status, 'success');
  assert.deepEqual(f.invocations, []);
});

test('dryRunChild suppresses providers in real local sub-pipeline and child-loop traversal', async (t) => {
  const f = fixture(t);
  shim.setConfigEntries({ 'intentRouter.runtime.sandbox.timeoutMs': 1000 });
  // Only the in-process system dispatcher is real; every effectful command is
  // intercepted before a provider can run. Fixtures stay in this temp folder.
  t.mock.restoreAll();
  registry.resetRegistry();
  const subscriptions = [];
  system.registerSystemProvider({ subscriptions });
  t.after(() => subscriptions.forEach((entry) => entry.dispose()));
  registry.registerCapabilities({ provider: 'sentinel', command: 'sentinel.effect', capabilities: ['terminal.run'] });
  const invoke = shim.commands.executeCommand;
  t.mock.method(shim.commands, 'executeCommand', async (id, ...args) => {
    if (['intentRouter.internal.systemSubPipeline', 'intentRouter.internal.systemLoop'].includes(id)) {
      return invoke(id, ...args);
    }
    f.invocations.push(id);
    return true;
  });
  fs.writeFileSync(path.join(f.root, 'child.intent.json'), JSON.stringify({ name: 'child', steps: [
    step('effect', 'terminal.run', {}, { meta: { dryRun: false } }),
    step('memory', 'memory.save', { sessionId: 'child', data: 'sentinel' })
  ] }));
  for (const intent of ['system.subPipeline', 'system.loop']) {
    const result = await runner.runPipelineFromData({ name: 'parent', steps: [
      step('child', intent, { pipelinePath: 'child.intent.json', dryRunChild: true, items: ['a', 'b'] })
    ] }, false);
    assert.equal(result.success, true, `${intent}: ${JSON.stringify(f.events.filter((event) => event.type === 'stepLog'))}`);
  }
  assert.deepEqual(f.invocations, []);
  assert.equal(fs.existsSync(path.join(f.root, '.intent-router', 'run-memory-v2.json')), false);
});
