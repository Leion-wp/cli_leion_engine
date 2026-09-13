const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const adapter = require('../packages/core/out/providers/julesAdapter');
const { getRuntimeCapabilities } = require('../packages/core/out/runtimeCatalog');
const registry = require('../packages/core/out/registry');
const shim = require('../packages/core/out/ports/vscodeShim');
const { pipelineEventBus } = require('../packages/core/out/eventBus');
const {
  RunSupervisorService, appendEventRecord, eventsFilePath, stateFilePath, writeJsonFile,
  projectRunEventPayload
} = require('../packages/core/out/services/runSupervisorService');

const session = (overrides = {}) => ({
  name: 'sessions/session-123',
  id: 'session-123',
  state: 'AWAITING_PLAN_APPROVAL',
  url: 'https://jules.google.com/session/session-123',
  createTime: '2026-09-13T10:00:00.000Z',
  updateTime: '2026-09-13T10:00:01.000Z',
  outputs: [],
  ...overrides
});

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(typeof error?.message, 'string');
    assert.ok(error.message.length <= 100);
    return true;
  };
}

function withApiKey(t, value) {
  const original = process.env.JULES_API_KEY;
  if (value === undefined) delete process.env.JULES_API_KEY;
  else process.env.JULES_API_KEY = value;
  t.after(() => {
    if (original === undefined) delete process.env.JULES_API_KEY;
    else process.env.JULES_API_KEY = original;
  });
}

test('Jules capabilities are omitted without a key and advertised with explicit requirements only when configured', (t) => {
  withApiKey(t, undefined);
  assert.equal(adapter.isJulesConfigured(), false);
  assert.deepEqual(getRuntimeCapabilities().filter((entry) => entry.capability.startsWith('jules.')), []);

  process.env.JULES_API_KEY = 'test-key';
  const descriptors = getRuntimeCapabilities().filter((entry) => entry.capability.startsWith('jules.'));
  assert.deepEqual(descriptors.map((entry) => entry.capability), [
    'jules.activities.list',
    'jules.plan.approve',
    'jules.session.create',
    'jules.session.get',
    'jules.sources.list'
  ]);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.available, true);
    assert.equal(descriptor.host, 'cli');
    assert.equal(descriptor.executionMode, 'provider');
    assert.deepEqual(descriptor.requirements, ['JULES_API_KEY', 'jules-account-access']);
  }
  assert.equal(descriptors.find((entry) => entry.capability === 'jules.session.create').risk, 'network-write');
  assert.equal(descriptors.find((entry) => entry.capability === 'jules.session.get').risk, 'read-only');
  for (const capability of ['jules.sources.list', 'jules.activities.list']) {
    assert.deepEqual(
      descriptors.find((entry) => entry.capability === capability).args.find((arg) => arg.name === 'pageSize').acceptedTypes,
      ['string', 'number']
    );
  }
});

test('provider registration is fail-closed when the API key is absent or malformed', (t) => {
  withApiKey(t, undefined);
  shim.resetHostPorts();
  registry.resetRegistry();
  assert.equal(adapter.registerJulesProvider({ subscriptions: [] }), false);
  assert.equal(registry.listPublicCapabilities().some((entry) => entry.capability.startsWith('jules.')), false);

  process.env.JULES_API_KEY = 'bad\nkey';
  assert.equal(adapter.isJulesConfigured(), false);
  assert.equal(adapter.registerJulesProvider({ subscriptions: [] }), false);
  assert.throws(() => adapter.createJulesClient(), expectCode('JULES_NOT_CONFIGURED'));
});

test('the registered approvePlan command requires a live human approval before network I/O', async (t) => {
  withApiKey(t, 'test-key');
  shim.resetHostPorts();
  registry.resetRegistry();
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; shim.resetHostPorts(); registry.resetRegistry(); });
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return new Response('', { status: 200 }); };
  assert.equal(adapter.registerJulesProvider({ subscriptions: [] }), true);
  await assert.rejects(
    shim.commands.executeCommand('intentRouter.internal.julesPlanApprove', { sessionId: 'session-123' }),
    expectCode('JULES_PLAN_APPROVAL_REQUIRED')
  );
  assert.equal(fetchCalls, 0);

  shim.setHostPorts({ interaction: { showWarningMessage: async () => 'Approve plan' } });
  const approved = await shim.commands.executeCommand('intentRouter.internal.julesPlanApprove', { sessionId: 'session-123' });
  assert.deepEqual(approved, { sessionId: 'session-123', approved: true });
  assert.equal(fetchCalls, 1);
});

test('session creation uses the fixed endpoint, header-only auth, mandatory approval, and a bounded projection', async () => {
  const secret = 'secret-test-key';
  const prompt = 'private prompt value';
  let call;
  const client = adapter.createJulesClient({
    apiKey: secret,
    fetchImpl: async (url, init) => {
      call = { url, init };
      return jsonResponse(session({
        prompt,
        accessToken: secret,
        title: 'private title',
        outputs: [{ pullRequest: {
          url: 'https://github.com/leion/repo/pull/42',
          title: 'possibly sensitive title',
          description: 'possibly sensitive description'
        } }]
      }));
    }
  });
  const result = await client.createSession({
    prompt,
    title: 'private title',
    source: 'sources/github/leion/repo',
    startingBranch: 'main',
    requirePlanApproval: true,
    autoCreatePr: true
  });
  assert.equal(call.url, 'https://jules.googleapis.com/v1alpha/sessions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers['x-goog-api-key'], secret);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, {
    prompt,
    title: 'private title',
    requirePlanApproval: true,
    sourceContext: {
      source: 'sources/github/leion/repo',
      githubRepoContext: { startingBranch: 'main' }
    },
    automationMode: 'AUTO_CREATE_PR'
  });
  assert.deepEqual(result.outputs, [{ pullRequest: {
    url: 'https://github.com/leion/repo/pull/42', owner: 'leion', repository: 'repo', number: 42
  } }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret-test-key|private prompt|private title|sensitive/);
});

test('session creation rejects bypasses of plan approval and invalid source combinations before network I/O', async () => {
  let calls = 0;
  const client = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => { calls += 1; return jsonResponse(session()); } });
  await assert.rejects(client.createSession({ prompt: 'task', requirePlanApproval: false }), expectCode('JULES_PLAN_APPROVAL_REQUIRED'));
  await assert.rejects(client.createSession({ prompt: 'task', source: 'sources/github/leion/repo' }), expectCode('JULES_REQUEST_INVALID'));
  await assert.rejects(client.createSession({ prompt: 'task', startingBranch: 'main' }), expectCode('JULES_REQUEST_INVALID'));
  await assert.rejects(client.createSession({ prompt: 'task', autoCreatePr: true }), expectCode('JULES_REQUEST_INVALID'));
  assert.equal(calls, 0);
});

test('arguments are own-data allowlists with multiline prompt and single-line identifiers', async () => {
  let calls = 0;
  let lastUrl = '';
  const client = adapter.createJulesClient({
    apiKey: 'test-key',
    baseUrl: 'https://attacker.invalid/v1alpha',
    fetchImpl: async (url) => { calls += 1; lastUrl = url; return jsonResponse(session()); }
  });
  await assert.rejects(client.createSession({ prompt: 'task', accessToken: 'unknown' }), expectCode('JULES_REQUEST_INVALID'));
  const inherited = Object.create({ prompt: 'inherited getter must not run' });
  await assert.rejects(client.createSession(inherited), expectCode('JULES_REQUEST_INVALID'));
  let getterRead = false;
  const accessor = {};
  Object.defineProperty(accessor, 'prompt', { enumerable: true, get() { getterRead = true; return 'task'; } });
  await assert.rejects(client.createSession(accessor), expectCode('JULES_REQUEST_INVALID'));
  assert.equal(getterRead, false);
  for (const args of [
    { prompt: 'task', title: 'bad\ntitle' },
    { prompt: 'task', source: 'sources/github/repo\n', startingBranch: 'main' },
    { prompt: 'task', source: 'sources/github/repo/', startingBranch: 'main' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: '../main' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: 'main lock.lock' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: '@' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: 'main/.hidden' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: 'main/topic.' },
    { prompt: 'task', source: 'sources/github/repo', startingBranch: 'main/topic.LOCK' }
  ]) await assert.rejects(client.createSession(args), expectCode('JULES_REQUEST_INVALID'));
  await assert.rejects(client.listSources({ pageToken: 'bad\ntoken' }), expectCode('JULES_REQUEST_INVALID'));
  await assert.rejects(client.getSession({ sessionId: 'bad\nid' }), expectCode('JULES_REQUEST_INVALID'));
  assert.equal(calls, 0);
  await client.createSession({ prompt: 'line one\nline two' });
  assert.equal(calls, 1);
  assert.equal(lastUrl, 'https://jules.googleapis.com/v1alpha/sessions');
});

test('source and activity pagination is bounded and strips messages, patches, shell output, and unknown fields', async () => {
  const secret = 'activity secret';
  const calls = [];
  const client = adapter.createJulesClient({
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/sources?')) return jsonResponse({
        sources: [{
          name: 'sources/github-leion-repo',
          id: 'github-leion-repo',
          githubRepo: { owner: 'leion', repo: 'repo', isPrivate: true, branches: [{ displayName: secret }] },
          accessToken: secret
        }],
        nextPageToken: 'sources-next'
      });
      return jsonResponse({
        activities: [{
          name: 'sessions/session-123/activities/activity-1',
          id: 'activity-1',
          originator: 'agent',
          createTime: '2026-09-13T10:00:02.000Z',
          agentMessaged: { message: secret },
          artifacts: [{ bashOutput: { output: secret } }, { changeSet: { patch: secret } }]
        }],
        nextPageToken: 'activities-next'
      });
    }
  });
  const sources = await client.listSources({ pageSize: '100', pageToken: 'opaque + token' });
  assert.deepEqual(sources, {
    sources: [{ name: 'sources/github-leion-repo', id: 'github-leion-repo', githubRepo: { owner: 'leion', repository: 'repo', isPrivate: true } }],
    nextPageToken: 'sources-next'
  });
  const activities = await client.listActivities({ sessionId: 'sessions/session-123', pageSize: 1, pageToken: 'next/activity' });
  assert.deepEqual(activities, {
    sessionId: 'session-123',
    activities: [{
      name: 'sessions/session-123/activities/activity-1', id: 'activity-1', type: 'agent_messaged', originator: 'agent', createTime: '2026-09-13T10:00:02.000Z'
    }],
    nextPageToken: 'activities-next'
  });
  assert.match(calls[0].url, /pageSize=100/);
  assert.match(calls[0].url, /pageToken=opaque\+%2B\+token/);
  assert.match(calls[1].url, /pageToken=next%2Factivity/);
  assert.doesNotMatch(JSON.stringify({ sources, activities }), new RegExp(secret));
  await assert.rejects(client.listSources({ pageSize: 101 }), expectCode('JULES_REQUEST_INVALID'));
  await assert.rejects(client.listActivities({ sessionId: 'session-123', pageSize: 0 }), expectCode('JULES_REQUEST_INVALID'));
  for (const activity of [
    { name: 'sessions/session-123/activities/a', id: 'a', originator: 'attacker', agentMessaged: {} },
    { name: 'sessions/session-123/activities/a', id: 'a', originator: 'agent', agentMessaged: 'raw-message' },
    { name: 'sessions/session-123/activities/nested/a', id: 'nested/a', originator: 'agent', agentMessaged: {} }
  ]) {
    const invalid = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse({ activities: [activity] }) });
    await assert.rejects(invalid.listActivities({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  }
  for (const id of ['/github/repo', 'github/repo/', 'github//repo', 'github/../repo']) {
    const invalid = adapter.createJulesClient({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ sources: [{ name: `sources/${id}`, id, githubRepo: { owner: 'leion', repo: 'repo' } }] })
    });
    await assert.rejects(invalid.listSources(), expectCode('JULES_RESPONSE_INVALID'));
  }
});

test('Jules journal projection enforces per-event fields, identities, and stable error codes', () => {
  assert.deepEqual(projectRunEventPayload('jules.plan_approved', {
    runId: 'run_1', sessionId: 'session-123', approved: true,
    prompt: 'secret', state: 'COMPLETED', code: 'JULES_AUTH_FAILED', pullRequestOwner: 'leion'
  }), { runId: 'run_1', sessionId: 'session-123', approved: true });
  assert.deepEqual(projectRunEventPayload('jules.request_failed', {
    sessionId: 'session-123', operation: 'session.get', code: 'NOT_IN_ALLOWLIST', message: 'secret'
  }), { sessionId: 'session-123', operation: 'session.get' });
  assert.deepEqual(projectRunEventPayload('jules.session_observed', {
    sessionId: 'session-123', state: 'COMPLETED',
    sessionUrl: 'https://jules.google.com/session/different-session'
  }), { sessionId: 'session-123', state: 'COMPLETED' });
  assert.deepEqual(projectRunEventPayload('jules.pull_request_observed', {
    sessionId: 'session-123', pullRequestOwner: 'leion', pullRequestRepository: 'repo',
    pullRequestNumber: 42, pullRequestUrl: 'https://github.com/leion/other/pull/42'
  }), { sessionId: 'session-123', pullRequestOwner: 'leion', pullRequestRepository: 'repo', pullRequestNumber: 42 });
});

test('get and approve use normalized session IDs and reject malformed GitHub outputs or unknown states', async () => {
  const urls = [];
  const client = adapter.createJulesClient({
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      urls.push(url);
      return url.endsWith(':approvePlan') ? new Response('', { status: 200 }) : jsonResponse(session({ state: 'COMPLETED' }));
    }
  });
  assert.equal((await client.getSession({ sessionId: 'sessions/session-123' })).state, 'COMPLETED');
  assert.deepEqual(await client.approvePlan({ sessionId: 'session-123' }), { sessionId: 'session-123', approved: true });
  assert.deepEqual(urls, [
    'https://jules.googleapis.com/v1alpha/sessions/session-123',
    'https://jules.googleapis.com/v1alpha/sessions/session-123:approvePlan'
  ]);

  const invalidState = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ state: 'NEW_UNDOCUMENTED_STATE' })) });
  await assert.rejects(invalidState.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  const invalidPr = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ outputs: [{ pullRequest: { url: 'https://evil.example/pull/1' } }] })) });
  await assert.rejects(invalidPr.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  for (const url of [
    'https://jules.google.com/session/session-123/',
    'https://sub.jules.google.com/session/session-123',
    'https://jules.google.com:8443/session/session-123',
    'https://jules.google.com/session/different-session',
    'https://jules.google.com/session/session-123?token=secret'
  ]) {
    const invalidUrl = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ url })) });
    await assert.rejects(invalidUrl.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  }
  for (const url of [
    'https://github.com/leion/repo/pull/42/',
    'https://github.com:8443/leion/repo/pull/42',
    'https://github.com/leion/repo/pull/42?token=secret',
    'https://github.com/%6ceion/repo/pull/42',
    'https://github.com/leion/repo/pull/042'
  ]) {
    const invalidUrl = adapter.createJulesClient({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse(session({ outputs: [{ pullRequest: { url } }] }))
    });
    await assert.rejects(invalidUrl.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  }
});

test('all documented states and Google UTC timestamp precisions are projected canonically', async () => {
  const states = [
    'STATE_UNSPECIFIED', 'QUEUED', 'PLANNING', 'AWAITING_PLAN_APPROVAL',
    'AWAITING_USER_FEEDBACK', 'IN_PROGRESS', 'PAUSED', 'FAILED', 'COMPLETED'
  ];
  for (const state of states) {
    const client = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ state })) });
    assert.equal((await client.getSession({ sessionId: 'session-123' })).state, state);
  }
  for (const [input, expected] of [
    ['2026-09-13T10:00:00Z', '2026-09-13T10:00:00.000Z'],
    ['2026-09-13T10:00:00.123Z', '2026-09-13T10:00:00.123Z'],
    ['2026-09-13T10:00:00.123456Z', '2026-09-13T10:00:00.123Z'],
    ['2026-09-13T10:00:00.123456789Z', '2026-09-13T10:00:00.123Z']
  ]) {
    const client = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ createTime: input })) });
    assert.equal((await client.getSession({ sessionId: 'session-123' })).createTime, expected);
  }
  for (const timestamp of ['0000-09-13T10:00:00Z', '2026-09-13T12:00:00+02:00', '2026-02-30T10:00:00Z', 'September 13, 2026']) {
    const invalid = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => jsonResponse(session({ updateTime: timestamp })) });
    await assert.rejects(invalid.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  }
});

test('session identity and PR output are journaled through a stable secret-free run_logs cursor', async (t) => {
  withApiKey(t, 'event-key-secret');
  shim.resetHostPorts();
  registry.resetRegistry();
  const originalFetch = global.fetch;
  const captured = [];
  const subscription = pipelineEventBus.on((event) => captured.push(event));
  t.after(() => { global.fetch = originalFetch; subscription.dispose(); shim.resetHostPorts(); registry.resetRegistry(); });
  global.fetch = async (url) => url.endsWith('/sessions/session-123')
    ? jsonResponse({ error: { message: 'event-upstream-error-secret' } }, 403)
    : jsonResponse(session({
        prompt: 'event-prompt-secret',
        title: 'event-title-secret',
        outputs: [{ pullRequest: {
          url: 'https://github.com/leion/repo/pull/77',
          title: 'event-pr-title-secret',
          description: 'event-pr-description-secret'
        } }]
      }));
  assert.equal(adapter.registerJulesProvider({ subscriptions: [] }), true);
  await shim.commands.executeCommand('intentRouter.internal.julesSessionCreate', {
    prompt: 'event-prompt-secret',
    title: 'event-title-secret',
    __meta: { runId: 'pipeline_run_1', traceId: 'trace_1', stepId: 'jules_create' }
  });
  await assert.rejects(
    shim.commands.executeCommand('intentRouter.internal.julesSessionGet', {
      sessionId: 'session-123',
      __meta: { runId: 'pipeline_run_1', traceId: 'trace_2', stepId: 'jules_get' }
    }),
    expectCode('JULES_AUTH_FAILED')
  );
  assert.deepEqual(captured.map((event) => event.type), [
    'jules.session_created', 'jules.pull_request_observed', 'jules.request_failed'
  ]);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-run-log-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const detachedRunId = 'run_jules_event';
  writeJsonFile(stateFilePath(workspace, detachedRunId), {
    detachedRunId, correlationId: 'jules:event:1', workspaceRoot: workspace,
    pipeline: 'jules', dryRun: false, status: 'success', startedAt: 1, updatedAt: 2, endedAt: 2
  });
  captured.forEach((event, index) => appendEventRecord(eventsFilePath(workspace, detachedRunId), {
    eventVersion: 1, ts: 1_789_300_000_000 + index, runId: event.runId || detachedRunId,
    type: event.type, payload: { ...event, accessToken: 'event-key-secret', prompt: 'event-prompt-secret', artifacts: ['secret'] }
  }));
  const firstSupervisor = new RunSupervisorService(workspace);
  const first = firstSupervisor.tail_events('jules:event:1', undefined, 10);
  const afterRestart = new RunSupervisorService(workspace).tail_events('jules:event:1', undefined, 10);
  assert.deepEqual(afterRestart, first);
  assert.deepEqual(first.events.map((event) => event.type), [
    'jules.session_created', 'jules.pull_request_observed', 'jules.request_failed'
  ]);
  assert.deepEqual(first.events[0].payload, {
    runId: 'pipeline_run_1', intentId: 'trace_1', stepId: 'jules_create',
    sessionId: 'session-123', state: 'AWAITING_PLAN_APPROVAL', sessionUrl: 'https://jules.google.com/session/session-123'
  });
  assert.deepEqual(first.events[1].payload, {
    runId: 'pipeline_run_1', intentId: 'trace_1', stepId: 'jules_create', sessionId: 'session-123',
    pullRequestUrl: 'https://github.com/leion/repo/pull/77', pullRequestOwner: 'leion',
    pullRequestRepository: 'repo', pullRequestNumber: 77
  });
  assert.deepEqual(first.events[2].payload, {
    runId: 'pipeline_run_1', intentId: 'trace_2', stepId: 'jules_get', sessionId: 'session-123',
    operation: 'session.get', code: 'JULES_AUTH_FAILED'
  });
  assert.equal(first.events.filter((event) => event.type === 'jules.request_failed').length, 1);
  assert.doesNotMatch(fs.readFileSync(eventsFilePath(workspace, detachedRunId), 'utf8'), /event-key-secret|event-prompt-secret|event-title-secret|event-pr-title-secret|event-upstream-error-secret|artifacts/);
  const finalPage = new RunSupervisorService(workspace).tail_events('jules:event:1', first.next_cursor, 10);
  assert.equal(finalPage.events.length, 0);
  assert.equal(finalPage.has_more, false);
});

test('HTTP failures have stable secret-free codes and are never retried automatically', async () => {
  const cases = [
    [400, 'JULES_REQUEST_INVALID'], [401, 'JULES_AUTH_FAILED'], [403, 'JULES_AUTH_FAILED'], [404, 'JULES_NOT_FOUND'],
    [409, 'JULES_INVALID_STATE'], [412, 'JULES_INVALID_STATE'], [429, 'JULES_RATE_LIMITED'],
    [503, 'JULES_UNAVAILABLE'], [500, 'JULES_UPSTREAM_ERROR']
  ];
  for (const [status, code] of cases) {
    let calls = 0;
    const client = adapter.createJulesClient({
      apiKey: 'test-key',
      fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message: `upstream-secret-${status}` } }, status); }
    });
    await assert.rejects(client.getSession({ sessionId: 'session-123' }), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify({ message: error.message, code: error.code }), /upstream-secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('timeout, oversized, malformed, and empty responses fail closed with bounded stable errors', async () => {
  const timeout = adapter.createJulesClient({
    apiKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('transport secret')), { once: true });
    })
  });
  await assert.rejects(timeout.getSession({ sessionId: 'session-123' }), expectCode('JULES_TIMEOUT'));

  const oversized = adapter.createJulesClient({
    apiKey: 'test-key', maxResponseBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(1025), { headers: { 'content-length': '1025' } })
  });
  await assert.rejects(oversized.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_TOO_LARGE'));

  for (const body of ['not-json', '[]', '']) {
    const malformed = adapter.createJulesClient({ apiKey: 'test-key', fetchImpl: async () => new Response(body) });
    await assert.rejects(malformed.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
  }
  const invalidUtf8 = adapter.createJulesClient({
    apiKey: 'test-key', fetchImpl: async () => new Response(Uint8Array.from([0xc3, 0x28]))
  });
  await assert.rejects(invalidUtf8.getSession({ sessionId: 'session-123' }), expectCode('JULES_RESPONSE_INVALID'));
});
