const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const core = require('../packages/core/out');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leion-correlation-cli-'));
  fs.mkdirSync(path.join(root, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline', 'demo.intent.json'), JSON.stringify({
    name: 'demo',
    steps: [{ id: 'set', intent: 'system.setVar', payload: { name: 'proof', value: 'safe' } }]
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, args, expectedStatus) {
  const entry = path.resolve(__dirname, '../packages/cli/out/index.js');
  const result = spawnSync(process.execPath, [entry, ...args, '--workspace', root, '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, `${result.stderr}\n${result.stdout}`);
  return {
    stdout: result.stdout ? JSON.parse(result.stdout) : undefined,
    stderr: result.stderr
  };
}

test('runtime descriptor advertises correlation status, list, logs and controls', (t) => {
  const root = workspace(t);
  const { stdout } = run(root, ['runtime_describe'], 0);
  for (const command of ['run_status', 'run_list', 'run_logs', 'stop_pipeline', 'resume_pipeline', 'cancel_pipeline']) {
    assert.ok(stdout.runtime.capabilities.includes(command), command);
  }
  const pipelineRun = stdout.capabilities.find((entry) => entry.capability === 'pipeline.run');
  assert.ok(pipelineRun.args.some((entry) => entry.name === 'correlation_id'));
  assert.deepEqual(stdout.runtime.contracts.run_logs, {
    version: '1',
    cursorFormat: 'lr1',
    cursorMonotone: true,
    legacyIntegerCursor: true,
    eventVersion: 1,
    stableEventIds: true,
    corruptionPolicy: 'projected_event',
    canonicalFields: ['run_id', 'detached_run_id', 'correlation_id', 'events', 'next_cursor', 'has_more'],
    limits: {
      default: 100,
      max: 200,
      maxRecordBytes: 16384,
      maxResponseBytes: 524288,
      maxScanBytes: 8388608
    }
  });
});

test('CLI lookup and validation errors expose stable protocol diagnostics without dispatch', (t) => {
  const root = workspace(t);
  const missingPipeline = run(root, ['run_pipeline', '--detached'], 1);
  assert.equal(missingPipeline.stdout.diagnostics[0].code, 'PIPELINE_REQUIRED');

  const missing = run(root, ['run_status', '--run_id', 'missing-correlation'], 1);
  assert.equal(missing.stdout.ok, false);
  assert.equal(missing.stdout.protocolVersion, '1');
  assert.equal(missing.stdout.diagnostics[0].code, 'RUN_NOT_FOUND');

  const cursor = run(root, ['run_logs', '--run_id', 'missing-correlation', '--cursor', '-1'], 1);
  assert.equal(cursor.stdout.diagnostics[0].code, 'RUN_CURSOR_INVALID');

  for (const value of ['0', '201', '1.5']) {
    const limit = run(root, ['run_logs', '--run_id', 'missing-correlation', '--limit', value], 1);
    assert.equal(limit.stdout.diagnostics[0].code, 'RUN_LIMIT_INVALID');
  }
  const missingLimit = run(root, ['run_logs', '--run_id', 'missing-correlation', '--limit'], 1);
  assert.equal(missingLimit.stdout.diagnostics[0].code, 'RUN_LIMIT_INVALID');

  const attached = run(root, ['run_pipeline', '--pipeline', 'demo', '--correlation_id', 'attached-key'], 1);
  assert.equal(attached.stdout.diagnostics[0].code, 'RUN_CORRELATION_REQUIRES_DETACHED');

  const missingCorrelationValue = run(root, ['run_pipeline', '--pipeline', 'demo', '--detached', '--correlation_id'], 1);
  assert.equal(missingCorrelationValue.stdout.diagnostics[0].code, 'RUN_CORRELATION_INVALID');

  const traversal = run(root, ['run_pipeline', '--pipeline', 'demo', '--detached', '--correlation_id', '../escape'], 1);
  assert.equal(traversal.stdout.diagnostics[0].code, 'RUN_CORRELATION_INVALID');
  assert.equal(fs.existsSync(path.join(root, 'escape.claim.json')), false);

  const listed = run(root, ['run_list'], 0);
  assert.deepEqual(listed.stdout, { runs: [] });
});

test('CLI run_logs returns the canonical control-plane page and stable retry cursor', (t) => {
  const root = workspace(t);
  const runId = 'run_cli_logs';
  const correlationId = 'delivery:cli:logs';
  const now = 1_700_000_000_000;
  core.writeJsonFile(core.stateFilePath(root, runId), {
    detachedRunId: runId,
    correlationId,
    workspaceRoot: fs.realpathSync.native(root),
    pipeline: 'demo',
    dryRun: true,
    status: 'success',
    startedAt: now,
    updatedAt: now,
    endedAt: now,
    result: { success: true, status: 'success' }
  });
  for (let index = 0; index < 2; index += 1) {
    core.appendEventRecord(core.eventsFilePath(root, runId), {
      eventVersion: 1,
      ts: now + index,
      runId,
      type: 'pipelineStep',
      payload: { nodeId: `step-${index}`, index, success: true }
    });
  }

  const first = run(root, ['run_logs', '--run_id', correlationId, '--limit', '1'], 0).stdout;
  assert.equal(first.run_id, correlationId);
  assert.equal(first.detached_run_id, runId);
  assert.equal(first.correlation_id, correlationId);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].sequence, 0);
  assert.equal(first.events[0].event_version, 1);
  assert.equal(first.events[0].detached_run_id, runId);
  assert.match(first.events[0].event_id, /^evt_[a-f0-9]{64}$/);
  assert.match(first.next_cursor, /^lr1\.1\.[0-9]+\.[a-f0-9]{16}$/);
  assert.equal(first.has_more, true);
  assert.equal(first.nextCursor, 1);
  assert.equal(first.hasMore, true);

  const retry = run(root, ['run_logs', '--run_id', correlationId, '--limit', '1'], 0).stdout;
  assert.deepEqual(retry, first);
  const second = run(root, ['run_logs', '--run_id', correlationId, '--cursor', first.next_cursor, '--limit', '1'], 0).stdout;
  assert.equal(second.events[0].sequence, 1);
  assert.equal(second.has_more, false);
  const empty = run(root, ['run_logs', '--run_id', correlationId, '--cursor', second.next_cursor], 0).stdout;
  assert.deepEqual(empty.events, []);
  assert.equal(empty.next_cursor, second.next_cursor);
  assert.equal(empty.has_more, false);
});
