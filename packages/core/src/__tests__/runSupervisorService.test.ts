import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { createHash } from 'crypto';
import {
    RUN_LOG_MAX_LIMIT,
    RUN_LOG_MAX_RECORD_BYTES,
    RUN_LOG_MAX_RESPONSE_BYTES
} from '../runLogContract';
import {
    DetachedRunState,
    RunSupervisorError,
    RunSupervisorService,
    STARTING_STATUS_GRACE_MS,
    appendEventRecord,
    correlationClaimFilePath,
    ctrlFilePath,
    eventsFilePath,
    executionClaimFilePath,
    stateFilePath,
    projectRunResult,
    sanitizeWorkerError,
    tryAcquireExecutionClaim,
    writeJsonFile
} from '../services/runSupervisorService';

function createWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'leion-correlation-'));
    fs.mkdirSync(path.join(workspace, 'pipeline'), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, 'pipeline', 'demo.intent.json'),
        JSON.stringify({ name: 'demo', steps: [] }),
        'utf8'
    );
    fs.writeFileSync(
        path.join(workspace, 'pipeline', 'other.intent.json'),
        JSON.stringify({ name: 'other', steps: [] }),
        'utf8'
    );
    return workspace;
}

function fakeSpawn(pid: number, onSpawn: () => void = () => {}): typeof cp.spawn {
    return ((..._args: any[]) => {
        onSpawn();
        return {
            pid,
            unref() { /* test double */ }
        } as cp.ChildProcess;
    }) as typeof cp.spawn;
}

function removeWorkspace(workspace: string): void {
    fs.rmSync(workspace, { recursive: true, force: true });
}

function waitForFiles(files: string[], timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (files.every((file) => fs.existsSync(file))) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`Timed out waiting for: ${files.join(', ')}`));
                return;
            }
            setTimeout(poll, 10);
        };
        poll();
    });
}

function runCaller(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const helperPath = path.resolve(__dirname, 'fixtures', 'concurrentCorrelationCaller.js');
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [helperPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ stdout, stderr, code }));
    });
}

function runLogAppender(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const helperPath = path.resolve(__dirname, 'fixtures', 'concurrentLogAppender.js');
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [helperPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ stdout, stderr, code }));
    });
}

function seedRunState(workspace: string, runId: string, correlationId?: string): DetachedRunState {
    const now = Date.now();
    const state: DetachedRunState = {
        detachedRunId: runId,
        ...(correlationId ? { correlationId } : {}),
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        dryRun: true,
        status: 'success',
        startedAt: now,
        updatedAt: now,
        endedAt: now,
        result: { success: true, status: 'success' }
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    return state;
}

function terminalEventOrderGuard(
    serviceModule: string,
    statePath: string,
    eventPath: string,
    sentinelPath: string,
    expectedType: string
): string[] {
    return [
        `const __supervisorService = require(${JSON.stringify(serviceModule)});`,
        `const __writeJsonFile = __supervisorService.writeJsonFile;`,
        `__supervisorService.writeJsonFile = (target, value) => {`,
        `  if (target === ${JSON.stringify(statePath)} && ['success','failure','cancelled'].includes(String(value && value.status))) {`,
        `    let types = [];`,
        `    try { types = fs.readFileSync(${JSON.stringify(eventPath)}, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line).type); } catch {}`,
        `    if (!types.includes(${JSON.stringify(expectedType)})) fs.writeFileSync(${JSON.stringify(sentinelPath)}, 'terminal-before-event');`,
        `  }`,
        `  return __writeJsonFile(target, value);`,
        `};`
    ];
}

function waitForChildExit(child: cp.ChildProcess): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ stdout, stderr, code }));
    });
}

test('correlation retry returns the same run and resolves status, logs, and control', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    let spawnCount = 0;
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(41001, () => { spawnCount += 1; }),
        isProcessAlive: (pid) => pid === 41001
    });

    const first = supervisor.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'delivery:42:attempt-1'
    });
    const retry = supervisor.start_detached({
        pipeline: path.join(workspace, 'pipeline', 'demo.intent.json'),
        dryRun: true,
        correlationId: 'delivery:42:attempt-1'
    });

    assert.equal(first.run_id, retry.run_id);
    assert.equal(first.correlation_id, 'delivery:42:attempt-1');
    assert.equal(retry.reused, true);
    assert.equal(spawnCount, 1);

    const state = supervisor.findRunState('delivery:42:attempt-1');
    assert.equal(state?.detachedRunId, first.run_id);
    assert.equal(supervisor.show_run(first.run_id)?.correlationId, 'delivery:42:attempt-1');
    assert.equal(supervisor.tail_events('delivery:42:attempt-1').events.length, 1);

    const control = supervisor.pause_run('delivery:42:attempt-1');
    assert.equal(control.detached_run_id, first.run_id);
    assert.equal(control.correlation_id, 'delivery:42:attempt-1');

    const serializedRuns = fs.readFileSync(stateFilePath(workspace, first.run_id), 'utf8').toLowerCase();
    assert.equal(serializedRuns.includes('"args"'), false);
    assert.equal(serializedRuns.includes('"secrets"'), false);
    const claimPath = correlationClaimFilePath(workspace, 'delivery:42:attempt-1');
    assert.equal(path.basename(claimPath).includes('delivery'), false);
});

test('correlation conflict has a stable code for immutable parameter divergence', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(42001),
        isProcessAlive: (pid) => pid === 42001
    });
    supervisor.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'same-key' });

    for (const changed of [
        { pipeline: 'demo', dryRun: false, correlationId: 'same-key' },
        { pipeline: 'demo', dryRun: true, from: 'step-2', correlationId: 'same-key' },
        { pipeline: 'other', dryRun: true, correlationId: 'same-key' }
    ]) {
        assert.throws(
            () => supervisor.start_detached(changed),
            (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_CORRELATION_CONFLICT'
        );
    }
});

test('detached start without correlation preserves the legacy detached status', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(41501),
        isProcessAlive: (pid) => pid === 41501
    });

    const result = supervisor.start_detached({ pipeline: 'demo', dryRun: true });

    assert.equal(result.status, 'detached');
    assert.equal(result.correlation_id, undefined);
});

test('pipeline bytes are immutable for a claimed correlation and changed content never respawns', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const first = new RunSupervisorService(workspace, {
        spawn: (() => { throw new Error('simulated crash before worker'); }) as typeof cp.spawn,
        isProcessAlive: () => false
    });
    assert.throws(
        () => first.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'immutable-pipeline' }),
        (error: any) => error?.code === 'RUN_WORKER_SPAWN_FAILED'
    );
    const stateBefore = first.findRunState('immutable-pipeline');
    assert.match(String(stateBefore?.pipelineHash), /^[a-f0-9]{64}$/);
    fs.writeFileSync(
        path.join(workspace, 'pipeline', 'demo.intent.json'),
        JSON.stringify({ name: 'demo', steps: [{ id: 'changed', intent: 'terminal.run', payload: { command: 'never' } }] }),
        'utf8'
    );
    let spawnCount = 0;
    const retry = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(42501, () => { spawnCount += 1; }),
        isProcessAlive: () => false
    });
    assert.throws(
        () => retry.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'immutable-pipeline' }),
        (error: any) => error?.code === 'RUN_CORRELATION_CONFLICT'
    );
    assert.equal(spawnCount, 0);
});

test('a starting correlation whose spawn failed is recovered with the same detached run', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    let currentTime = 10_000;
    const crashing = new RunSupervisorService(workspace, {
        spawn: (() => { throw new Error('simulated parent crash before spawn'); }) as typeof cp.spawn,
        isProcessAlive: () => false,
        now: () => currentTime
    });

    assert.throws(
        () => crashing.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'recover-me' }),
        (error: any) => error?.code === 'RUN_WORKER_SPAWN_FAILED'
    );
    const stranded = crashing.findRunState('recover-me');
    assert.equal(stranded?.status, 'starting');
    assert.equal(stranded?.pid, undefined);
    assert.equal(crashing.getRunStatus('recover-me')?.status, 'starting');
    currentTime += STARTING_STATUS_GRACE_MS;
    const reported = crashing.getRunStatus('recover-me');
    assert.equal(reported?.status, 'failure');
    assert.equal(reported?.errorCode, 'RUN_WORKER_NOT_RUNNING');
    assert.equal(reported?.orphanedStatus, 'starting');
    assert.equal(crashing.findRunState('recover-me')?.status, 'starting');

    let spawnCount = 0;
    const recovering = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43001, () => { spawnCount += 1; }),
        isProcessAlive: (pid) => pid === 43001
    });
    const recovered = recovering.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'recover-me'
    });

    assert.equal(recovered.run_id, stranded?.detachedRunId);
    assert.equal(recovered.recovered, true);
    assert.equal(spawnCount, 1);
});

test('status cannot fail a fresh starting state during the state-to-spawn-claim handoff', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const originalLinkSync = fs.linkSync;
    let statusDuringHandoff: DetachedRunState | undefined;
    const observer = new RunSupervisorService(workspace, { isProcessAlive: () => false });
    (fs as any).linkSync = (existingPath: fs.PathLike, newPath: fs.PathLike) => {
        originalLinkSync(existingPath, newPath);
        if (String(newPath).endsWith('.json') && path.basename(String(newPath)).startsWith('run_handoff_window')) {
            statusDuringHandoff = observer.getRunStatus('handoff-window');
        }
    };
    t.after(() => { (fs as any).linkSync = originalLinkSync; });

    const starter = new RunSupervisorService(workspace, {
        generateRunId: () => 'run_handoff_window',
        spawn: fakeSpawn(43201),
        isProcessAlive: (pid) => pid === 43201
    });
    const started = starter.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'handoff-window'
    });

    assert.equal(statusDuringHandoff?.status, 'starting');
    assert.equal(statusDuringHandoff?.errorCode, undefined);
    assert.equal(started.status, 'starting');
    assert.equal(started.pid, 43201);
});

test('a completion racing retry under the spawn claim wins without a second spawn', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    let initialSpawns = 0;
    const initial = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43301, () => { initialSpawns += 1; }),
        isProcessAlive: (pid) => pid === 43301
    });
    const first = initial.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'completion-race'
    });
    assert.equal(initialSpawns, 1);

    const originalLinkSync = fs.linkSync;
    let terminalWriteInterleaved = false;
    (fs as any).linkSync = (existingPath: fs.PathLike, newPath: fs.PathLike) => {
        originalLinkSync(existingPath, newPath);
        if (String(newPath).endsWith('.spawn.claim')) {
            const statePath = stateFilePath(workspace, first.run_id);
            const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            writeJsonFile(statePath, {
                ...current,
                status: 'success',
                result: { success: true, status: 'success' },
                endedAt: Date.now(),
                updatedAt: Date.now()
            });
            terminalWriteInterleaved = true;
        }
    };
    t.after(() => { (fs as any).linkSync = originalLinkSync; });

    let retrySpawns = 0;
    const retrying = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43302, () => { retrySpawns += 1; }),
        isProcessAlive: () => false
    });
    const retry = retrying.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'completion-race'
    });

    assert.equal(terminalWriteInterleaved, true);
    assert.equal(retry.run_id, first.run_id);
    assert.equal(retry.status, 'success');
    assert.equal(retrySpawns, 0);
});

test('status marks a dead running worker failed and a retry never reruns it', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const starting = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43501),
        isProcessAlive: (pid) => pid === 43501
    });
    const started = starting.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'dead-running-worker'
    });
    const statePath = stateFilePath(workspace, started.run_id);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    writeJsonFile(statePath, { ...state, status: 'running' });

    let retrySpawns = 0;
    const observer = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43502, () => { retrySpawns += 1; }),
        isProcessAlive: () => false
    });
    const status = observer.getRunStatus('dead-running-worker');
    assert.equal(status?.status, 'failure');
    assert.equal(status?.errorCode, 'RUN_WORKER_NOT_RUNNING');
    assert.equal(status?.orphanedStatus, 'running');
    assert.equal(observer.findRunState('dead-running-worker')?.status, 'running');
    const retry = observer.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'dead-running-worker'
    });
    assert.equal(retry.status, 'failure');
    assert.equal(retrySpawns, 0);
});

test('status preserves a terminal state written while worker liveness is being reconciled', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const statePath = stateFilePath(workspace, 'run_terminal_race');
    const running: DetachedRunState = {
        detachedRunId: 'run_terminal_race',
        correlationId: 'terminal-race',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        dryRun: true,
        status: 'running',
        pid: 43901,
        startedAt: 100,
        updatedAt: 200
    };
    writeJsonFile(statePath, running);
    let livenessChecks = 0;
    const observer = new RunSupervisorService(workspace, {
        now: () => 10_000,
        isProcessAlive: (pid) => {
            livenessChecks += 1;
            if (pid === 43901 && livenessChecks === 2) {
                writeJsonFile(statePath, {
                    ...running,
                    status: 'success',
                    result: { success: true, status: 'success' },
                    endedAt: 300,
                    updatedAt: 300
                });
            }
            return false;
        }
    });

    const status = observer.getRunStatus('terminal-race');

    assert.ok(livenessChecks >= 2);
    assert.equal(status?.status, 'success');
    assert.equal(status?.errorCode, undefined);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'success');
});

test('controls reject terminal runs without rewriting state or creating a control request', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_terminal_control';
    const terminal: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'terminal-control',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        dryRun: true,
        status: 'success',
        startedAt: 100,
        updatedAt: 200,
        endedAt: 200,
        result: { success: true, status: 'success' }
    };
    const statePath = stateFilePath(workspace, runId);
    writeJsonFile(statePath, terminal);
    const supervisor = new RunSupervisorService(workspace, { now: () => 300 });

    for (const control of [
        () => supervisor.pause_run('terminal-control'),
        () => supervisor.resume_run('terminal-control'),
        () => supervisor.cancel_run('terminal-control')
    ]) {
        assert.throws(
            control,
            (error: any) => error?.code === 'RUN_CONTROL_INVALID_STATE'
        );
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), terminal);
    assert.equal(fs.existsSync(ctrlFilePath(workspace, runId)), false);
});

test('controls reject reconciled dead workers and use unique request ids', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_control_requests';
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'control-requests',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        dryRun: true,
        status: 'running',
        pid: 43911,
        startedAt: 100,
        updatedAt: 200
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    const deadObserver = new RunSupervisorService(workspace, {
        now: () => 10_000,
        isProcessAlive: () => false
    });
    assert.throws(
        () => deadObserver.cancel_run('control-requests'),
        (error: any) => error?.code === 'RUN_CONTROL_INVALID_STATE'
    );

    const liveSupervisor = new RunSupervisorService(workspace, {
        now: () => 10_000,
        isProcessAlive: (pid) => pid === 43911
    });
    liveSupervisor.pause_run('control-requests');
    const first = JSON.parse(fs.readFileSync(ctrlFilePath(workspace, runId), 'utf8'));
    liveSupervisor.resume_run('control-requests');
    const second = JSON.parse(fs.readFileSync(ctrlFilePath(workspace, runId), 'utf8'));
    assert.match(first.requestId, /^[a-f0-9]{24}$/);
    assert.match(second.requestId, /^[a-f0-9]{24}$/);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.updatedAt, second.updatedAt);
});

test('atomic JSON replacement attempts to fsync the parent directory', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const originalFsyncSync = fs.fsyncSync;
    let directoryFsyncAttempts = 0;
    (fs as any).fsyncSync = (descriptor: number) => {
        if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncAttempts += 1;
        return originalFsyncSync(descriptor);
    };
    t.after(() => { (fs as any).fsyncSync = originalFsyncSync; });

    writeJsonFile(path.join(workspace, 'atomic.json'), { ok: true });
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(43902),
        isProcessAlive: (pid) => pid === 43902
    });
    supervisor.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'fsync-claims' });

    assert.ok(directoryFsyncAttempts >= 5, `expected rename and link fsync attempts, got ${directoryFsyncAttempts}`);
});

test('two processes claim one correlation and request only one worker spawn', async (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const readyA = path.join(workspace, 'ready-a');
    const readyB = path.join(workspace, 'ready-b');
    const barrier = path.join(workspace, 'barrier');
    const spawnLog = path.join(workspace, 'spawn.log');
    const common = [workspace, 'concurrent-key'];
    const firstPromise = runCaller([...common, readyA, barrier, spawnLog]);
    const secondPromise = runCaller([...common, readyB, barrier, spawnLog]);

    await waitForFiles([readyA, readyB]);
    fs.writeFileSync(barrier, 'go', 'utf8');
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const firstResult = JSON.parse(first.stdout);
    const secondResult = JSON.parse(second.stdout);
    assert.equal(firstResult.run_id, secondResult.run_id);
    assert.equal(firstResult.correlation_id, 'concurrent-key');
    assert.equal(secondResult.correlation_id, 'concurrent-key');
    const spawnLines = fs.readFileSync(spawnLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(spawnLines.length, 1);
});

test('execution claim prevents a second worker from entering the runtime', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_execution_claim_test';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'worker-claim',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    assert.equal(tryAcquireExecutionClaim(workspace, runId), true);

    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(eventsFilePath(workspace, runId)), false);
});

test('worker rejects changed pipeline bytes before constructing CoreRuntime', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_pipeline_changed_test';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'pipeline-changed',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    fs.writeFileSync(pipelinePath, JSON.stringify({ name: 'changed', steps: [] }), 'utf8');
    const preloadPath = path.join(workspace, 'no-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    fs.writeFileSync(preloadPath, `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class { constructor() { throw new Error('RUNTIME_CONSTRUCTED'); } };`, 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /RUNTIME_CONSTRUCTED/);
    const failed = JSON.parse(fs.readFileSync(stateFilePath(workspace, runId), 'utf8'));
    assert.equal(failed.status, 'failure');
    assert.equal(failed.errorCode, 'RUN_PIPELINE_CHANGED');
    assert.equal(failed.error, 'Pipeline content changed before execution.');
    assert.equal(fs.existsSync(executionClaimFilePath(workspace, runId)), true);
});

test('worker holds execution claim and spawn handoff before publishing a pipeline hash failure', async (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_hash_handoff_test';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'hash-handoff',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    const statePath = stateFilePath(workspace, runId);
    const spawnClaimPath = path.join(path.dirname(statePath), `${runId}.spawn.claim`);
    writeJsonFile(statePath, state);
    writeJsonFile(spawnClaimPath, { claimVersion: 1, ownerPid: process.pid, createdAt: Date.now() });
    fs.writeFileSync(pipelinePath, JSON.stringify({ name: 'changed', steps: [] }), 'utf8');

    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const child = cp.spawn(process.execPath, [
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exitPromise = waitForChildExit(child);
    await waitForFiles([executionClaimFilePath(workspace, runId)]);

    writeJsonFile(statePath, { ...state, pid: child.pid, updatedAt: Date.now() });
    fs.unlinkSync(spawnClaimPath);
    const result = await exitPromise;

    assert.equal(result.code, 1);
    const failed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(failed.status, 'failure');
    assert.equal(failed.errorCode, 'RUN_PIPELINE_CHANGED');
});

test('worker honors a cancel request present before runtime execution', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_cancel_before_start';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'cancel-before-start',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    writeJsonFile(ctrlFilePath(workspace, runId), {
        action: 'cancel', requestedRunId: 'cancel-before-start', requestId: 'pre-start-cancel', updatedAt: Date.now()
    });
    const executionSentinel = path.join(workspace, 'runtime-executed');
    const orderSentinel = path.join(workspace, 'terminal-before-finished');
    const preloadPath = path.join(workspace, 'cancel-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    const serviceModule = path.resolve(__dirname, '..', 'services', 'runSupervisorService.js');
    fs.writeFileSync(preloadPath, [
        `const fs = require('fs');`,
        ...terminalEventOrderGuard(
            serviceModule,
            stateFilePath(workspace, runId),
            eventsFilePath(workspace, runId),
            orderSentinel,
            'run.worker_finished'
        ),
        `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class {`,
        `  async run_pipeline_data() { fs.writeFileSync(${JSON.stringify(executionSentinel)}, 'called'); return { runId: 'unexpected', success: true, status: 'success' }; }`,
        `  pause() {} resume() {} cancel() {}`,
        `};`
    ].join('\n'), 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(executionSentinel), false);
    assert.equal(fs.existsSync(orderSentinel), false);
    const cancelled = JSON.parse(fs.readFileSync(stateFilePath(workspace, runId), 'utf8'));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result.status, 'cancelled');
});

test('worker keeps root run state nonterminal across nested pipeline events', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_nested_events';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'nested-events',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    const statePath = stateFilePath(workspace, runId);
    writeJsonFile(statePath, state);
    const prematureTerminal = path.join(workspace, 'premature-terminal');
    const orderSentinel = path.join(workspace, 'terminal-before-finished');
    const preloadPath = path.join(workspace, 'nested-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    const eventBusModule = path.resolve(__dirname, '..', 'eventBus.js');
    const serviceModule = path.resolve(__dirname, '..', 'services', 'runSupervisorService.js');
    fs.writeFileSync(preloadPath, [
        `const fs = require('fs');`,
        ...terminalEventOrderGuard(
            serviceModule,
            statePath,
            eventsFilePath(workspace, runId),
            orderSentinel,
            'run.worker_finished'
        ),
        `const bus = require(${JSON.stringify(eventBusModule)}).pipelineEventBus;`,
        `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class {`,
        `  async run_pipeline_data() {`,
        `    bus.emit({ type: 'pipelineStart', runId: 'root-runtime', timestamp: Date.now() });`,
        `    bus.emit({ type: 'pipelineStart', runId: 'child-runtime', timestamp: Date.now() });`,
        `    bus.emit({ type: 'pipelineEnd', runId: 'child-runtime', timestamp: Date.now(), success: true, status: 'success' });`,
        `    const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));`,
        `    if (state.pipelineRunId !== 'root-runtime' || ['success','failure','cancelled'].includes(state.status)) fs.writeFileSync(${JSON.stringify(prematureTerminal)}, 'bad');`,
        `    bus.emit({ type: 'pipelineEnd', runId: 'root-runtime', timestamp: Date.now(), success: true, status: 'success' });`,
        `    return { runId: 'root-runtime', success: true, status: 'success' };`,
        `  }`,
        `  pause() {} resume() {} cancel() {}`,
        `};`
    ].join('\n'), 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(prematureTerminal), false);
    assert.equal(fs.existsSync(orderSentinel), false);
    const completed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(completed.pipelineRunId, 'root-runtime');
    assert.equal(completed.status, 'success');
    assert.equal(completed.result.runId, 'root-runtime');
});

test('event journal failure cannot change successful execution or terminal state', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_event_failure';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'event-failure',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    const statePath = stateFilePath(workspace, runId);
    writeJsonFile(statePath, state);
    const preloadPath = path.join(workspace, 'event-failure-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    const eventBusModule = path.resolve(__dirname, '..', 'eventBus.js');
    fs.writeFileSync(preloadPath, [
        `const fs = require('fs');`,
        `const bus = require(${JSON.stringify(eventBusModule)}).pipelineEventBus;`,
        `fs.appendFileSync = () => { throw new Error('journal unavailable'); };`,
        `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class {`,
        `  async run_pipeline_data() {`,
        `    bus.emit({ type: 'pipelineStart', runId: 'root-event-failure', timestamp: Date.now() });`,
        `    bus.emit({ type: 'stepEnd', runId: 'root-event-failure', intentId: 'step', stepId: 'step', timestamp: Date.now(), success: true });`,
        `    bus.emit({ type: 'pipelineEnd', runId: 'root-event-failure', timestamp: Date.now(), success: true, status: 'success' });`,
        `    return { runId: 'root-event-failure', success: true, status: 'success' };`,
        `  }`,
        `  pause() {} resume() {} cancel() {}`,
        `};`
    ].join('\n'), 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const completed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(completed.status, 'success');
    assert.equal(completed.result.runId, 'root-event-failure');
});

test('worker publishes a sanitized error event before catch makes state terminal', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_error_order';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'error-order',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    const statePath = stateFilePath(workspace, runId);
    const eventPath = eventsFilePath(workspace, runId);
    writeJsonFile(statePath, state);
    const orderSentinel = path.join(workspace, 'terminal-before-error');
    const preloadPath = path.join(workspace, 'error-order-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    const serviceModule = path.resolve(__dirname, '..', 'services', 'runSupervisorService.js');
    fs.writeFileSync(preloadPath, [
        `const fs = require('fs');`,
        ...terminalEventOrderGuard(serviceModule, statePath, eventPath, orderSentinel, 'run.worker_error'),
        `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class {`,
        `  async run_pipeline_data() { throw new Error('provider-secret-error'); }`,
        `  pause() {} resume() {} cancel() {}`,
        `};`
    ].join('\n'), 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const result = cp.spawnSync(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(orderSentinel), false);
    const completed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(completed.status, 'failure');
    assert.equal(completed.errorCode, 'RUN_WORKER_FAILED');
    const serializedEvents = fs.readFileSync(eventPath, 'utf8');
    assert.match(serializedEvents, /"type":"run\.worker_error"/);
    assert.equal(serializedEvents.includes('provider-secret-error'), false);
});

test('worker reapplies a cancel received before pipelineStart to the root run id', async (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_cancel_handoff';
    const pipelinePath = fs.realpathSync.native(path.join(workspace, 'pipeline', 'demo.intent.json'));
    const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
    const state: DetachedRunState = {
        detachedRunId: runId,
        correlationId: 'cancel-handoff',
        workspaceRoot: fs.realpathSync.native(workspace),
        pipeline: 'demo',
        pipelinePath,
        pipelineHash,
        dryRun: true,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    writeJsonFile(stateFilePath(workspace, runId), state);
    const readyPath = path.join(workspace, 'runtime-ready');
    const cancelTargetPath = path.join(workspace, 'cancel-target');
    const preloadPath = path.join(workspace, 'delayed-runtime.cjs');
    const runtimeModule = path.resolve(__dirname, '..', 'coreRuntime.js');
    const eventBusModule = path.resolve(__dirname, '..', 'eventBus.js');
    fs.writeFileSync(preloadPath, [
        `const fs = require('fs');`,
        `const bus = require(${JSON.stringify(eventBusModule)}).pipelineEventBus;`,
        `const wait = ms => new Promise(resolve => setTimeout(resolve, ms));`,
        `require(${JSON.stringify(runtimeModule)}).CoreRuntime = class {`,
        `  async run_pipeline_data() {`,
        `    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        `    await wait(650);`,
        `    bus.emit({ type: 'pipelineStart', runId: 'root-delayed', timestamp: Date.now() });`,
        `    await wait(25);`,
        `    bus.emit({ type: 'pipelineEnd', runId: 'root-delayed', timestamp: Date.now(), success: false, status: 'cancelled' });`,
        `    return { runId: 'root-delayed', success: false, status: 'cancelled' };`,
        `  }`,
        `  pause() {} resume() {}`,
        `  cancel(runId) { fs.writeFileSync(${JSON.stringify(cancelTargetPath)}, String(runId)); }`,
        `};`
    ].join('\n'), 'utf8');
    const workerPath = path.resolve(__dirname, '..', 'services', 'runSupervisorWorker.js');
    const child = cp.spawn(process.execPath, [
        '--require', preloadPath,
        workerPath,
        '--workspace', state.workspaceRoot,
        '--run_id', runId,
        '--pipeline', 'demo',
        '--pipeline_path', pipelinePath,
        '--pipeline_hash', pipelineHash,
        '--dry_run'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exitPromise = waitForChildExit(child);
    await waitForFiles([readyPath]);
    writeJsonFile(ctrlFilePath(workspace, runId), {
        action: 'cancel', requestedRunId: 'cancel-handoff', requestId: 'cancel-during-handoff', updatedAt: Date.now()
    });
    const result = await exitPromise;

    assert.equal(result.code, 1, result.stderr);
    assert.equal(fs.readFileSync(cancelTargetPath, 'utf8'), 'root-delayed');
    const cancelled = JSON.parse(fs.readFileSync(stateFilePath(workspace, runId), 'utf8'));
    assert.equal(cancelled.pipelineRunId, 'root-delayed');
    assert.equal(cancelled.status, 'cancelled');
});

test('retry repairs a missing pid from the active execution claim without spawning', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const initial = new RunSupervisorService(workspace, {
        spawn: (() => { throw new Error('simulated crash'); }) as typeof cp.spawn,
        isProcessAlive: () => false
    });
    assert.throws(
        () => initial.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'execution-handoff' }),
        (error: any) => error?.code === 'RUN_WORKER_SPAWN_FAILED'
    );
    const stranded = initial.findRunState('execution-handoff');
    assert.ok(stranded);
    assert.equal(stranded.pid, undefined);
    assert.equal(tryAcquireExecutionClaim(workspace, stranded.detachedRunId), true);

    let spawnCount = 0;
    const retrying = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(45001, () => { spawnCount += 1; }),
        isProcessAlive: (pid) => pid === process.pid
    });
    const retry = retrying.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'execution-handoff'
    });

    assert.equal(retry.run_id, stranded.detachedRunId);
    assert.equal(retry.pid, process.pid);
    assert.equal(retry.recovered, true);
    assert.equal(spawnCount, 0);
});

test('spawn success plus pid persistence failure hands recovery to the claimed worker', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    let spawned = 0;
    const failing = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(process.pid, () => {
            spawned += 1;
            assert.equal(tryAcquireExecutionClaim(workspace, 'run_persist_failure'), true);
        }),
        generateRunId: () => 'run_persist_failure',
        isProcessAlive: (pid) => pid === process.pid,
        persistState: () => { throw new Error('simulated atomic state failure'); }
    });
    assert.throws(
        () => failing.start_detached({ pipeline: 'demo', dryRun: true, correlationId: 'persist-failure' }),
        (error: any) => error?.code === 'RUN_STATE_PERSIST_FAILED'
    );
    assert.equal(spawned, 1);

    let retrySpawns = 0;
    const recovering = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(46001, () => { retrySpawns += 1; }),
        isProcessAlive: (pid) => pid === process.pid
    });
    const result = recovering.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'persist-failure'
    });
    assert.equal(result.run_id, 'run_persist_failure');
    assert.equal(result.pid, process.pid);
    assert.equal(result.recovered, true);
    assert.equal(retrySpawns, 0);
});

test('a partial correlation claim is quarantined and atomically recovered', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const claimPath = correlationClaimFilePath(workspace, 'partial-claim');
    fs.writeFileSync(claimPath, '{"claimVersion":', 'utf8');
    let spawnCount = 0;
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(47001, () => { spawnCount += 1; }),
        isProcessAlive: (pid) => pid === 47001
    });

    const result = supervisor.start_detached({
        pipeline: 'demo',
        dryRun: true,
        correlationId: 'partial-claim'
    });

    assert.equal(result.correlation_id, 'partial-claim');
    assert.equal(spawnCount, 1);
    const parsed = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    assert.equal(parsed.detachedRunId, result.run_id);
    const quarantined = fs.readdirSync(path.dirname(claimPath))
        .filter((entry) => entry.startsWith(`${path.basename(claimPath)}.corrupt.`));
    assert.equal(quarantined.length, 1);
});

test('invalid and path-like correlation ids cannot influence storage paths', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const supervisor = new RunSupervisorService(workspace, {
        spawn: fakeSpawn(44001),
        isProcessAlive: () => true
    });

    for (const correlationId of ['../escape', '..\\escape', '/absolute', 'white space', '']) {
        assert.throws(
            () => supervisor.start_detached({ pipeline: 'demo', dryRun: true, correlationId }),
            (error: any) => error?.code === 'RUN_CORRELATION_INVALID'
        );
    }
    assert.equal(fs.existsSync(path.join(workspace, 'escape.claim.json')), false);
});

test('event journal uses an allowlist and persists only hashes for log text', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_redaction_test';
    const eventPath = eventsFilePath(workspace, runId);
    appendEventRecord(eventPath, {
        eventVersion: 1,
        ts: Date.now(),
        runId,
        type: 'pipelineStart',
        payload: {
            runId: 'visible-run-id',
            args: ['--token', 'raw-secret'],
            accessToken: 'raw-access-token',
            text: 'raw-log-text',
            intent: 'raw-intent-secret',
            decision: 'raw-decision-secret',
            pipeline: {
                steps: [{ payload: { secretRef: 'vault:key', apiKey: 'raw-key', value: 'kept' } }]
            }
        }
    });
    const serialized = fs.readFileSync(eventPath, 'utf8');
    assert.equal(serialized.includes('raw-secret'), false);
    assert.equal(serialized.includes('vault:key'), false);
    assert.equal(serialized.includes('raw-key'), false);
    assert.equal(serialized.includes('raw-access-token'), false);
    assert.equal(serialized.includes('raw-log-text'), false);
    assert.equal(serialized.includes('raw-intent-secret'), false);
    assert.equal(serialized.includes('raw-decision-secret'), false);
    assert.equal(serialized.includes('visible-run-id'), true);
    assert.equal(serialized.includes('kept'), false);

    appendEventRecord(eventPath, {
        eventVersion: 1,
        ts: Date.now(),
        runId,
        type: 'stepLog',
        payload: { runId, stepId: 'safe-step', stream: 'stderr', text: 'log-secret-value' }
    });
    appendEventRecord(eventPath, {
        eventVersion: 1,
        ts: Date.now(),
        runId,
        type: 'run.worker_error',
        payload: { code: 'RUN_WORKER_FAILED', message: 'error-secret-value' }
    });
    const allEvents = fs.readFileSync(eventPath, 'utf8');
    assert.equal(allEvents.includes('log-secret-value'), false);
    assert.equal(allEvents.includes('error-secret-value'), false);
    assert.match(allEvents, /"textSha256":"[a-f0-9]{64}"/);
    assert.deepEqual(projectRunResult({
        runId: 'runtime-1', success: true, status: 'success', output: 'result-secret-value'
    }), { runId: 'runtime-1', success: true, status: 'success' });
    const safeError = sanitizeWorkerError(Object.assign(new Error('exception-secret-value'), { code: 'UPSTREAM_FAILED' }));
    assert.deepEqual(safeError, { code: 'RUN_WORKER_FAILED', message: 'Detached worker failed.' });
    assert.equal(JSON.stringify(safeError).includes('exception-secret-value'), false);
});

test('run_logs returns stable opaque cursors and event identities across retries and legacy cursors', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_paging';
    const correlationId = 'delivery:logs:paging';
    seedRunState(workspace, runId, correlationId);
    const eventPath = eventsFilePath(workspace, runId);
    for (let index = 0; index < 3; index += 1) {
        appendEventRecord(eventPath, {
            eventVersion: 1,
            ts: 1_700_000_000_000 + index,
            runId,
            type: 'pipelineStep',
            payload: { nodeId: `step-${index}`, index, success: true }
        });
    }
    const supervisor = new RunSupervisorService(workspace);

    const first = supervisor.tail_events(correlationId, undefined, 2);
    const retry = supervisor.tail_events(correlationId, undefined, 2);
    assert.deepEqual(retry, first);
    assert.equal(first.run_id, correlationId);
    assert.equal(first.detached_run_id, runId);
    assert.equal(first.correlation_id, correlationId);
    assert.equal(first.events.length, 2);
    assert.deepEqual(first.events.map((event) => event.sequence), [0, 1]);
    assert.equal(new Set(first.events.map((event) => event.event_id)).size, 2);
    assert.ok(first.events.every((event) => event.event_version === 1));
    assert.ok(first.events.every((event) => event.detached_run_id === runId));
    assert.ok(first.events.every((event) => event.correlation_id === correlationId));
    assert.match(first.next_cursor, /^lr1\.2\.[0-9]+\.[a-f0-9]{16}$/);
    assert.equal(first.nextCursor, 2);
    assert.equal(first.has_more, true);
    assert.equal(first.hasMore, true);

    const final = supervisor.tail_events(correlationId, first.next_cursor, 2);
    assert.equal(final.events.length, 1);
    assert.equal(final.events[0].sequence, 2);
    assert.equal(final.has_more, false);
    assert.match(final.next_cursor, /^lr1\.3\.[0-9]+\.[a-f0-9]{16}$/);
    assert.deepEqual(supervisor.tail_events(correlationId, first.next_cursor, 2), final);

    const legacy = supervisor.tail_events(correlationId, 2, 2);
    assert.equal(legacy.events.length, 1);
    assert.equal(legacy.events[0].event_id, final.events[0].event_id);
    assert.equal(legacy.events[0].sequence, final.events[0].sequence);
    const empty = supervisor.tail_events(correlationId, final.next_cursor, 2);
    assert.deepEqual(empty.events, []);
    assert.equal(empty.next_cursor, final.next_cursor);
    assert.equal(empty.has_more, false);
});

test('run_logs projects corrupt and oversize records without secrets or cursor gaps', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_corruption';
    const correlationId = 'delivery:logs:corruption';
    seedRunState(workspace, runId, correlationId);
    const eventPath = eventsFilePath(workspace, runId);
    fs.mkdirSync(path.dirname(eventPath), { recursive: true });
    const rawSecret = 'secret-never-returned';
    fs.appendFileSync(eventPath, `${JSON.stringify({
        eventVersion: 1,
        ts: 1_700_000_000_000,
        runId,
        type: 'stepLog',
        payload: {
            stepId: 'safe-step', stream: 'stderr', text: rawSecret,
            accessToken: 'raw-access-token', nested: { apiKey: 'raw-key' }
        }
    })}\n`, 'utf8');
    fs.appendFileSync(eventPath, '{malformed-json}\n', 'utf8');
    fs.appendFileSync(eventPath, Buffer.concat([
        Buffer.alloc(RUN_LOG_MAX_RECORD_BYTES + 1, 0x78),
        Buffer.from('\n', 'utf8')
    ]));
    fs.appendFileSync(eventPath, '{"eventVersion":', 'utf8');

    const supervisor = new RunSupervisorService(workspace);
    const beforeCompletion = supervisor.tail_events(correlationId, undefined, RUN_LOG_MAX_LIMIT);
    assert.equal(beforeCompletion.events.length, 3);
    assert.deepEqual(beforeCompletion.events.map((event) => event.sequence), [0, 1, 2]);
    assert.equal(beforeCompletion.has_more, false);
    assert.equal(beforeCompletion.events[1].type, 'run.record_corrupt');
    assert.deepEqual(beforeCompletion.events[1].payload, { code: 'RUN_LOG_RECORD_CORRUPT' });
    assert.equal(beforeCompletion.events[2].type, 'run.record_oversize');
    assert.deepEqual(beforeCompletion.events[2].payload, { code: 'RUN_LOG_RECORD_OVERSIZE' });
    assert.equal(JSON.stringify(beforeCompletion).includes(rawSecret), false);
    assert.equal(JSON.stringify(beforeCompletion).includes('raw-access-token'), false);
    assert.equal(JSON.stringify(beforeCompletion).includes('raw-key'), false);
    assert.equal(beforeCompletion.events[0].payload.textLength, Buffer.byteLength(rawSecret));
    assert.match(beforeCompletion.events[0].payload.textSha256, /^[a-f0-9]{64}$/);

    const stableRetry = supervisor.tail_events(correlationId, undefined, RUN_LOG_MAX_LIMIT);
    assert.deepEqual(stableRetry, beforeCompletion);
    fs.appendFileSync(eventPath, 'oops}\n', 'utf8');
    const completed = supervisor.tail_events(correlationId, beforeCompletion.next_cursor, RUN_LOG_MAX_LIMIT);
    assert.equal(completed.events.length, 1);
    assert.equal(completed.events[0].sequence, 3);
    assert.equal(completed.events[0].type, 'run.record_corrupt');
    assert.equal(completed.has_more, false);

    assert.throws(
        () => supervisor.tail_events(correlationId, 5, 10),
        (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_CURSOR_INVALID'
    );
    const tampered = completed.next_cursor.replace(/[a-f0-9]$/, (value) => value === '0' ? '1' : '0');
    assert.throws(
        () => supervisor.tail_events(correlationId, tampered, 10),
        (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_CURSOR_INVALID'
    );
    const otherRunId = 'run_log_other';
    seedRunState(workspace, otherRunId, 'delivery:logs:other');
    assert.throws(
        () => supervisor.tail_events(otherRunId, completed.next_cursor, 10),
        (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_CURSOR_INVALID'
    );
});

test('run_logs leaves an incomplete EOF record pending without a cursor spin', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_fragment';
    seedRunState(workspace, runId);
    const eventPath = eventsFilePath(workspace, runId);
    fs.mkdirSync(path.dirname(eventPath), { recursive: true });
    fs.writeFileSync(eventPath, '{"eventVersion":', 'utf8');
    const supervisor = new RunSupervisorService(workspace);

    const pending = supervisor.tail_events(runId);
    assert.deepEqual(pending.events, []);
    assert.equal(pending.has_more, false);
    assert.match(pending.next_cursor, /^lr1\.0\.0\.[a-f0-9]{16}$/);
    assert.deepEqual(supervisor.tail_events(runId, pending.next_cursor), pending);

    fs.appendFileSync(eventPath, 'oops}\n', 'utf8');
    const complete = supervisor.tail_events(runId, pending.next_cursor);
    assert.equal(complete.events.length, 1);
    assert.equal(complete.events[0].type, 'run.record_corrupt');
    assert.equal(complete.events[0].sequence, 0);
    assert.equal(complete.has_more, false);
    assert.notEqual(complete.next_cursor, pending.next_cursor);
});

test('run_logs does not spin on an exact scan-window EOF fragment', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_scan_window';
    seedRunState(workspace, runId);
    const eventPath = eventsFilePath(workspace, runId);
    fs.mkdirSync(path.dirname(eventPath), { recursive: true });
    fs.writeFileSync(eventPath, Buffer.alloc(8 * 1024 * 1024, 0x78));
    const supervisor = new RunSupervisorService(workspace);

    const pending = supervisor.tail_events(runId);
    assert.deepEqual(pending.events, []);
    assert.equal(pending.has_more, false);
    assert.match(pending.next_cursor, /^lr1\.0\.0\.[a-f0-9]{16}$/);
    assert.deepEqual(supervisor.tail_events(runId, pending.next_cursor), pending);

    fs.appendFileSync(eventPath, 'x', 'utf8');
    assert.throws(
        () => supervisor.tail_events(runId, pending.next_cursor),
        (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_LOG_SCAN_LIMIT'
    );
});

test('run_logs enforces page and response limits', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_limits';
    seedRunState(workspace, runId);
    const supervisor = new RunSupervisorService(workspace);
    for (const invalid of [0, -1, 1.5, RUN_LOG_MAX_LIMIT + 1, Number.NaN]) {
        assert.throws(
            () => supervisor.tail_events(runId, undefined, invalid),
            (error: any) => error instanceof RunSupervisorError && error.code === 'RUN_LIMIT_INVALID'
        );
    }
    const eventPath = eventsFilePath(workspace, runId);
    const longId = `A${'a'.repeat(255)}`;
    const longType = `T${'t'.repeat(254)}`;
    for (let index = 0; index < RUN_LOG_MAX_LIMIT + 5; index += 1) {
        appendEventRecord(eventPath, {
            eventVersion: 1,
            ts: index,
            runId,
            type: longType,
            payload: {
                runId: longId,
                intentId: longId,
                nodeId: longId,
                stepId: longId,
                detachedRunId: longId,
                correlationId: longId,
                index,
                timestamp: index,
                totalSteps: index,
                completedSteps: index,
                checkpointEveryNodes: index,
                success: true,
                dryRun: true,
                status: 'running',
                stream: 'stdout',
                action: 'pause',
                code: 'RUN_TEST'
            }
        });
    }
    let cursor: string | undefined;
    const sequences: number[] = [];
    let firstPageLength = 0;
    do {
        const page = supervisor.tail_events(runId, cursor, RUN_LOG_MAX_LIMIT);
        if (cursor === undefined) firstPageLength = page.events.length;
        assert.ok(page.events.length > 0);
        assert.ok(
            Buffer.byteLength(`${JSON.stringify(page, null, 2)}\n`, 'utf8') <= RUN_LOG_MAX_RESPONSE_BYTES
        );
        sequences.push(...page.events.map((event) => event.sequence));
        cursor = page.next_cursor;
        if (!page.has_more) break;
    } while (true);
    assert.ok(firstPageLength < RUN_LOG_MAX_LIMIT, `expected response cap below ${RUN_LOG_MAX_LIMIT}`);
    assert.deepEqual(
        sequences,
        Array.from({ length: RUN_LOG_MAX_LIMIT + 5 }, (_, index) => index)
    );
});

test('run_logs preserves a pipeline run id separately from the detached run id', (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_pipeline_identity';
    const pipelineRunId = 'pipeline_runtime_123';
    const state = seedRunState(workspace, runId, 'delivery:logs:identity');
    writeJsonFile(stateFilePath(workspace, runId), { ...state, pipelineRunId });
    appendEventRecord(eventsFilePath(workspace, runId), {
        eventVersion: 1,
        ts: 1_700_000_000_000,
        runId: pipelineRunId,
        type: 'pipelineStart',
        payload: { runId: pipelineRunId }
    });

    const page = new RunSupervisorService(workspace).tail_events('delivery:logs:identity');
    assert.equal(page.detached_run_id, runId);
    assert.equal(page.events[0].run_id, pipelineRunId);
    assert.equal(page.events[0].runId, pipelineRunId);
    assert.equal(page.events[0].detached_run_id, runId);
    assert.notEqual(page.events[0].run_id, page.events[0].detached_run_id);
});

test('concurrent event appenders produce a gapless stable stream', async (t) => {
    const workspace = createWorkspace();
    t.after(() => removeWorkspace(workspace));
    const runId = 'run_log_concurrent';
    const correlationId = 'delivery:logs:concurrent';
    seedRunState(workspace, runId, correlationId);
    const eventPath = eventsFilePath(workspace, runId);
    const readyA = path.join(workspace, 'log-ready-a');
    const readyB = path.join(workspace, 'log-ready-b');
    const barrier = path.join(workspace, 'log-barrier');
    const count = 40;
    const firstPromise = runLogAppender([eventPath, runId, 'a', readyA, barrier, String(count)]);
    const secondPromise = runLogAppender([eventPath, runId, 'b', readyB, barrier, String(count)]);
    await waitForFiles([readyA, readyB]);
    fs.writeFileSync(barrier, 'go', 'utf8');
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    const supervisor = new RunSupervisorService(workspace);
    const page = supervisor.tail_events(correlationId, undefined, RUN_LOG_MAX_LIMIT);
    assert.equal(page.events.length, count * 2);
    assert.equal(page.has_more, false);
    assert.deepEqual(page.events.map((event) => event.sequence), Array.from({ length: count * 2 }, (_, index) => index));
    assert.equal(new Set(page.events.map((event) => event.event_id)).size, count * 2);
    assert.equal(page.events.some((event) => event.type === 'run.record_corrupt'), false);
    assert.equal(page.events.some((event) => event.type === 'run.record_oversize'), false);
    assert.deepEqual(supervisor.tail_events(correlationId, undefined, RUN_LOG_MAX_LIMIT), page);
});
