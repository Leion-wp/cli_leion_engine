const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, step, shim, registry } = require('./runtime-fixture.cjs');
const runner = require('../packages/core/out/pipelineRunner');
const router = require('../packages/core/out/router');

function lifecycle(events, runId, stepId) {
  return events.filter((event) => event.type === 'step_lifecycle'
    && (!runId || event.runId === runId)
    && (!stepId || event.stepId === stepId));
}

test('runtime run ids stay unique under rapid, concurrent, and nested execution', async (t) => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 256 }, (_, index) =>
    runner.runPipelineFromData({ name: `rapid-${index}`, steps: [] }, true)));
  const runIds = results.map((result) => result.runId);
  assert.equal(new Set(runIds).size, runIds.length);
  assert.ok(runIds.every((runId) => /^runtime_[a-z0-9]+_[a-z0-9]{16}$/.test(runId)));

  const originalRoute = router.routeIntent;
  t.mock.method(router, 'routeIntent', async (intent, variables) => {
    if (intent.id === 'nested-trigger') {
      const child = await runner.runPipelineFromData({
        name: 'nested-child',
        steps: [step('nested-child-step', 'system.setVar', { name: 'child', value: 'ok' })]
      }, false, undefined, { subPipelineDepth: 1 });
      assert.equal(child.success, true);
      return true;
    }
    return originalRoute(intent, variables);
  });
  const nested = await runner.runPipelineFromData({
    name: 'nested-root',
    steps: [step('nested-trigger', 'sentinel.nested')]
  }, false);
  assert.equal(nested.success, true);
  const nestedStarts = f.events.filter((event) => event.type === 'pipelineStart' && /nested-/.test(String(event.name)));
  assert.equal(nestedStarts.length, 2);
  assert.notEqual(nestedStarts[0].runId, nestedStarts[1].runId);
  const rootFacts = lifecycle(f.events, nestedStarts[0].runId, 'nested-trigger');
  const childFacts = lifecycle(f.events, nestedStarts[1].runId, 'nested-child-step');
  assert.deepEqual(rootFacts.map((event) => event.state), ['running', 'succeeded']);
  assert.deepEqual(childFacts.map((event) => event.state), ['running', 'succeeded']);
  assert.notEqual(rootFacts[0].logicalExecutionId, childFacts[0].logicalExecutionId);
  assert.equal(f.events.filter((event) => event.type === 'stepStart' && event.runId === nestedStarts[0].runId).length, 1);
  assert.equal(f.events.filter((event) => event.type === 'stepEnd' && event.runId === nestedStarts[0].runId).length, 1);
});

test('runner retry emits one legacy pair and one canonical attempt sequence', async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(router, 'routeIntent', async () => ++calls >= 2);
  const result = await runner.runPipelineFromData({
    name: 'retry-lifecycle',
    steps: [step('retry-step', 'sentinel.retry', {}, {
      retry: { mode: 'fixed', maxAttempts: 2, delayMs: 1 }
    })]
  }, false);
  assert.equal(result.success, true);
  assert.equal(f.events.filter((event) => event.type === 'stepStart' && event.stepId === 'retry-step').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'stepEnd' && event.stepId === 'retry-step').length, 1);
  const facts = lifecycle(f.events, result.runId, 'retry-step');
  assert.deepEqual(facts.map((event) => [event.state, event.attempt]), [
    ['running', 1], ['retrying', 1], ['running', 2], ['succeeded', 2]
  ]);
  assert.equal(new Set(facts.map((event) => event.logicalExecutionId)).size, 1);
});

test('runner emits skipped dry-run and blocked branch terminals', async (t) => {
  const f = fixture(t);
  const result = await runner.runPipelineFromData({
    name: 'skipped-lifecycle',
    steps: [
      step('preview-form', 'system.form', { fields: [{ key: 'never', required: true }] }, { meta: { dryRun: true } }),
      step('seed', 'system.setVar', { name: 'choice', value: 'selected' }),
      step('switch', 'system.switch', {
        variableKey: 'choice',
        routes: [{ condition: 'equals', value: 'selected', targetStepId: 'selected' }],
        defaultStepId: 'blocked'
      }),
      step('selected', 'system.setVar', { name: 'selected', value: 'yes' }),
      step('blocked', 'system.setVar', { name: 'blocked', value: 'no' })
    ]
  }, false);
  assert.equal(result.success, true);
  assert.deepEqual(lifecycle(f.events, result.runId, 'preview-form').map((event) => event.state), ['running', 'skipped']);
  assert.deepEqual(lifecycle(f.events, result.runId, 'blocked').map((event) => event.state), ['skipped']);
});

test('compile failure and cancellation close their started logical executions', async (t) => {
  const compileFixture = fixture(t);
  const compileResult = await runner.runPipelineFromData({
    name: 'compile-failure',
    steps: [step('bad-script', 'terminal.run', {
      __kind: 'script', scriptPath: 'unsupported.fixture'
    })]
  }, false);
  assert.equal(compileResult.status, 'failure');
  assert.deepEqual(lifecycle(compileFixture.events, compileResult.runId, 'bad-script').map((event) => event.state), ['running', 'failed']);

  const cancelEvents = [];
  t.mock.method(router, 'routeIntent', async () => {
    runner.cancelCurrentPipeline();
    return false;
  });
  const subscription = require('../packages/core/out/eventBus').pipelineEventBus.on((event) => cancelEvents.push(event));
  try {
    const cancelled = await runner.runPipelineFromData({
      name: 'cancel-lifecycle',
      steps: [step('cancel-step', 'sentinel.cancel')]
    }, false);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(lifecycle(cancelEvents, cancelled.runId, 'cancel-step').map((event) => event.state), ['running', 'cancelled']);
  } finally {
    subscription.dispose();
  }
});

test('graph segment targets emit distinct running and terminal facts before loop error handling', async (t) => {
  const successFixture = fixture(t);
  t.mock.method(router, 'routeIntent', async () => true);
  const success = await runner.runPipelineFromData({
    name: 'graph-success',
    steps: [
      step('loop', 'system.loop', {
        executionMode: 'graph_segment', items: ['a', 'b'], graphStepIds: ['target'], doneStepId: 'done'
      }),
      step('target', 'sentinel.graph'),
      step('done', 'system.setVar', { name: 'done', value: 'yes' })
    ]
  }, false);
  assert.equal(success.success, true);
  const successFacts = lifecycle(successFixture.events, success.runId, 'target');
  assert.deepEqual(successFacts.map((event) => event.state), ['running', 'succeeded', 'running', 'succeeded']);
  assert.equal(new Set(successFacts.filter((event) => event.state === 'running').map((event) => event.intentId)).size, 2);
  assert.equal(new Set(successFacts.filter((event) => event.state === 'running').map((event) => event.logicalExecutionId)).size, 2);

  t.mock.restoreAll();
  shim.resetHostPorts();
  shim.setHostPorts({ workspaceRoot: successFixture.root });
  registry.resetRegistry();
  const failureEvents = [];
  const subscription = require('../packages/core/out/eventBus').pipelineEventBus.on((event) => failureEvents.push(event));
  t.after(() => subscription.dispose());
  t.mock.method(router, 'routeIntent', async () => false);
  const failed = await runner.runPipelineFromData({
    name: 'graph-failure',
    steps: [
      step('loop-fail', 'system.loop', {
        executionMode: 'graph_segment', items: ['a'], graphStepIds: ['target-fail'], errorStrategy: 'fail_fast'
      }),
      step('target-fail', 'sentinel.graph')
    ]
  }, false);
  assert.equal(failed.status, 'failure');
  const failedFacts = lifecycle(failureEvents, failed.runId, 'target-fail');
  assert.deepEqual(failedFacts.map((event) => event.state), ['running', 'failed']);
  const loopTerminalIndex = failureEvents.findIndex((event) => event.type === 'step_lifecycle' && event.stepId === 'loop-fail' && event.state === 'failed');
  const targetTerminalIndex = failureEvents.findIndex((event) => event.type === 'step_lifecycle' && event.stepId === 'target-fail' && event.state === 'failed');
  assert.ok(targetTerminalIndex >= 0 && targetTerminalIndex < loopTerminalIndex);
});
