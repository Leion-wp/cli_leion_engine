const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluatePolicyCheck, executePolicyCheck } = require('../packages/core/out/policyCapability');
const { getRuntimeCapabilities } = require('../packages/core/out/runtimeCatalog');
const { CoreRuntime } = require('../packages/core/out/coreRuntime');

function policy(subject, rules, mode = 'block') {
  return { subject, rules, mode };
}

test('system.policy.check is published once as an available CLI capability', () => {
  const entries = getRuntimeCapabilities().filter((entry) => entry.capability === 'system.policy.check');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'system');
  assert.equal(entries[0].available, true);
  assert.equal(entries[0].risk, 'none');
  assert.deepEqual(entries[0].requirements, []);
  assert.deepEqual(entries[0].args.find((arg) => arg.name === 'rules').acceptedTypes, ['array']);
});

test('policy evaluator supports equals, regex and min_length on JSON-string subjects', () => {
  const subject = JSON.stringify({
    schemaVersion: '1',
    repo: 'example/project',
    ci: { requiredChecks: ['unit', 'e2e'], complete: true }
  });
  const result = evaluatePolicyCheck(policy(subject, [
    { kind: 'equals', path: 'schemaVersion', value: '1' },
    { kind: 'regex', path: 'repo', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
    { kind: 'equals', path: 'ci.complete', value: true },
    { kind: 'min_length', path: 'ci.requiredChecks', value: 1 }
  ]));
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test('policy evaluator can target a scalar root path', () => {
  assert.equal(evaluatePolicyCheck(policy('factory-pr-monitor', [
    { kind: 'regex', path: '', pattern: '^factory-(pr-monitor|next-work)$' }
  ])).passed, true);
});

test('block mode fails closed on missing paths and mismatches', () => {
  assert.throws(() => executePolicyCheck(policy({ quality: { verdict: 'REWORK' } }, [
    { kind: 'equals', path: 'quality.verdict', value: 'PASS', message: 'quality must pass' },
    { kind: 'equals', path: 'quality.risk', value: 'low' }
  ])), /POLICY_BLOCKED: quality must pass; Missing policy path: quality\.risk/);
});

test('warn mode reports violations without throwing', () => {
  const result = executePolicyCheck(policy({ value: 'x' }, [
    { kind: 'min_length', path: 'value', value: 2 }
  ], 'warn'));
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.mode, 'warn');
  assert.equal(parsed.violations.length, 1);
});

test('invalid policy definitions fail closed', () => {
  assert.throws(() => evaluatePolicyCheck(policy({}, [])), /POLICY_INVALID/);
  assert.throws(() => evaluatePolicyCheck(policy({}, [{ kind: 'unknown', path: '' }])), /POLICY_INVALID/);
  assert.throws(() => evaluatePolicyCheck(policy('abc', [{ kind: 'regex', path: '', pattern: '[' }])), /POLICY_INVALID/);
  assert.throws(() => evaluatePolicyCheck(policy([], [{ kind: 'min_length', path: '', value: -1 }])), /POLICY_INVALID/);
});

test('CoreRuntime executes policy checks and blocks a failing pipeline step', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leion-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runtime = new CoreRuntime({ workspaceRoot: root });
  const pass = await runtime.run_pipeline_data({
    name: 'policy-pass',
    intent: 'pipeline.run',
    steps: [{
      id: 'gate',
      intent: 'system.policy.check',
      payload: {
        subject: { schemaVersion: '1', checks: ['unit'] },
        rules: [
          { kind: 'equals', path: 'schemaVersion', value: '1' },
          { kind: 'min_length', path: 'checks', value: 1 }
        ],
        mode: 'block'
      }
    }]
  });
  assert.equal(pass.success, true);
  assert.equal(pass.status, 'success');

  const blocked = await runtime.run_pipeline_data({
    name: 'policy-blocked',
    intent: 'pipeline.run',
    steps: [{
      id: 'gate',
      intent: 'system.policy.check',
      payload: {
        subject: { risk: 'high' },
        rules: [{ kind: 'equals', path: 'risk', value: 'low' }],
        mode: 'block'
      }
    }]
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.status, 'failure');
});
