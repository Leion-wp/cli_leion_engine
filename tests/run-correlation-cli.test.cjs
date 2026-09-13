const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

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
