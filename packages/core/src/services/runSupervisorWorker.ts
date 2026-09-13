import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { CoreRuntime } from '../coreRuntime';
import { pipelineEventBus } from '../eventBus';
import {
    appendEventRecord,
    ctrlFilePath,
    eventsFilePath,
    projectRunResult,
    sanitizeWorkerError,
    stateFilePath,
    tryAcquireExecutionClaim,
    waitForSpawnClaimRelease,
    writeJsonFile,
    DetachedRunState,
    RunStatus
} from './runSupervisorService';

type WorkerArgs = {
    workspaceRoot: string;
    runId: string;
    pipeline: string;
    pipelinePath: string;
    pipelineHash: string;
    from?: string;
    dryRun: boolean;
    verbose: boolean;
};

function parseArgs(argv: string[]): WorkerArgs {
    const flags: Record<string, string | boolean> = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            index += 1;
        } else {
            flags[key] = true;
        }
    }

    const workspaceRoot = String(flags.workspace || '').trim();
    const runId = String(flags.run_id || '').trim();
    const pipeline = String(flags.pipeline || '').trim();
    const pipelinePath = String(flags.pipeline_path || '').trim();
    const pipelineHash = String(flags.pipeline_hash || '').trim();
    if (!workspaceRoot || !runId || !pipeline || !pipelinePath || !/^[a-f0-9]{64}$/.test(pipelineHash)) {
        throw new Error('runSupervisorWorker requires --workspace --run_id --pipeline --pipeline_path --pipeline_hash');
    }
    return {
        workspaceRoot,
        runId,
        pipeline,
        pipelinePath,
        pipelineHash,
        from: String(flags.from || '').trim() || undefined,
        dryRun: flags.dry_run === true || String(flags.dry_run || '').trim() === 'true',
        verbose: flags.verbose === true
    };
}

function safeReadJson(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function toPositiveInt(value: any, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function loadCheckpointEveryNodes(workspaceRoot: string, fallback = 1): number {
    const configPath = `${workspaceRoot}/.intent-router/config.json`;
    const parsed = safeReadJson(configPath);
    const mode = String(
        parsed?.intentRouter?.runtime?.checkpoint?.mode
        ?? parsed?.['intentRouter.runtime.checkpoint.mode']
        ?? 'node_interval'
    ).trim().toLowerCase();
    if (mode && mode !== 'node_interval') {
        return fallback;
    }
    const nested = parsed?.intentRouter?.runtime?.checkpoint?.everyNodes;
    const flat = parsed?.['intentRouter.runtime.checkpoint.everyNodes'];
    return toPositiveInt(nested ?? flat, fallback);
}

function failBeforeRuntime(
    statePath: string,
    eventsPath: string,
    state: DetachedRunState,
    code: string,
    message: string
): never {
    const now = Date.now();
    writeJsonFile(statePath, {
        ...state,
        status: 'failure',
        errorCode: code,
        error: message,
        endedAt: now,
        updatedAt: now
    });
    appendEventRecord(eventsPath, {
        eventVersion: 1,
        ts: now,
        runId: state.detachedRunId,
        type: 'run.worker_error',
        payload: { code }
    });
    throw Object.assign(new Error(message), { code });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const statePath = stateFilePath(args.workspaceRoot, args.runId);
    const controlPath = ctrlFilePath(args.workspaceRoot, args.runId);
    const eventsPath = eventsFilePath(args.workspaceRoot, args.runId);

    const loadedState = safeReadJson(statePath) as DetachedRunState | undefined;
    if (!loadedState) {
        throw new Error('Detached run state is missing.');
    }
    let state: DetachedRunState = loadedState;
    if (
        state.detachedRunId !== args.runId
        || path.resolve(state.workspaceRoot) !== path.resolve(args.workspaceRoot)
        || path.resolve(String(state.pipelinePath || '')) !== path.resolve(args.pipelinePath)
        || state.pipelineHash !== args.pipelineHash
        || (state.from || undefined) !== (args.from || undefined)
        || state.dryRun !== args.dryRun
    ) {
        throw new Error('Detached worker arguments do not match the persisted run state.');
    }
    if (!tryAcquireExecutionClaim(args.workspaceRoot, args.runId)) {
        return;
    }
    waitForSpawnClaimRelease(args.workspaceRoot, args.runId);
    state = (safeReadJson(statePath) || state) as DetachedRunState;
    state = {
        ...state,
        pid: process.pid,
        updatedAt: Date.now()
    };
    writeJsonFile(statePath, state);

    let pipelineBytes: Buffer;
    try {
        pipelineBytes = fs.readFileSync(args.pipelinePath);
    } catch {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_CHANGED', 'Pipeline content changed before execution.');
    }
    const actualHash = createHash('sha256').update(pipelineBytes).digest('hex');
    if (actualHash !== args.pipelineHash) {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_CHANGED', 'Pipeline content changed before execution.');
    }
    let pipelineData: any;
    try {
        pipelineData = JSON.parse(pipelineBytes.toString('utf8'));
    } catch {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_INVALID', 'Pipeline content is not valid JSON.');
    }

    const runtime = new CoreRuntime({
        workspaceRoot: args.workspaceRoot,
        blockedIntentPrefixes: ['vscode.'],
        hostPorts: {
            workspaceRoot: args.workspaceRoot,
            event_sink: {
                log: (_channel: string, line: string) => {
                    if (args.verbose) {
                        process.stdout.write(`${line}\n`);
                    }
                },
                warn: (message: string) => process.stderr.write(`${message}\n`),
                error: (message: string) => process.stderr.write(`${message}\n`)
            }
        }
    });

    state.checkpointEveryNodes = toPositiveInt(
        state.checkpointEveryNodes,
        loadCheckpointEveryNodes(args.workspaceRoot, 1)
    );
    writeJsonFile(statePath, state);

    const appendEvent = (type: string, payload: any, runIdOverride?: string) => {
        const eventRunId = String(runIdOverride || state.pipelineRunId || args.runId || '').trim() || args.runId;
        try {
            appendEventRecord(eventsPath, {
                eventVersion: 1,
                ts: Date.now(),
                runId: eventRunId,
                type,
                payload
            });
        } catch {
            // Observability must not alter pipeline execution or terminal state.
        }
    };

    appendEvent('run.worker_started', {
        detachedRunId: args.runId,
        pipeline: args.pipeline,
        pipelinePath: args.pipelinePath,
        from: args.from,
        dryRun: args.dryRun
    }, args.runId);

    let pauseRequested = state.pauseRequested === true;
    let pauseApplied = state.status === 'paused';
    let cancelRequested = state.cancelRequested === true;
    let rootRunId = String(state.pipelineRunId || '').trim() || undefined;
    let completedSteps = 0;
    let lastControlRequestId = '';

    const writeState = (patch?: Partial<DetachedRunState>) => {
        state = {
            ...state,
            ...(patch || {}),
            updatedAt: Date.now()
        };
        writeJsonFile(statePath, state);
    };

    const subscription = pipelineEventBus.on((event: any) => {
        const eventRunId = String(event?.runId || '').trim() || undefined;
        appendEvent(String(event?.type || 'unknown'), event, eventRunId);

        if (event?.type === 'pipelineStart') {
            if (rootRunId && eventRunId !== rootRunId) return;
            rootRunId = eventRunId || rootRunId;
            writeState({
                pipelineRunId: rootRunId || state.pipelineRunId,
                status: 'running'
            });
            if (cancelRequested && rootRunId) {
                runtime.cancel(rootRunId);
            } else if (pauseRequested && rootRunId) {
                runtime.pause(rootRunId);
            }
            return;
        }

        if (!rootRunId || eventRunId !== rootRunId) return;

        if (event?.type === 'stepEnd') {
            completedSteps += 1;
            const checkpointEveryNodes = toPositiveInt(state.checkpointEveryNodes, 1);
            if (pauseRequested && !pauseApplied && completedSteps % checkpointEveryNodes === 0) {
                const targetRunId = String(state.pipelineRunId || args.runId).trim();
                runtime.pause(targetRunId);
                pauseApplied = true;
                pauseRequested = false;
                writeState({
                    pauseRequested: false,
                    status: 'paused'
                });
                appendEvent('run.paused_checkpoint', {
                    stepId: String(event?.stepId || '').trim() || undefined,
                    completedSteps,
                    checkpointEveryNodes
                }, targetRunId);
            }
            return;
        }

        if (event?.type === 'pipelinePause') {
            pauseApplied = true;
            pauseRequested = false;
            writeState({
                pauseRequested: false,
                status: 'paused'
            });
            return;
        }

        if (event?.type === 'pipelineResume') {
            pauseApplied = false;
            writeState({ status: 'running' });
            return;
        }

        if (event?.type === 'pipelineEnd') {
            const nextStatus: RunStatus = cancelRequested
                ? 'cancelled'
                : (event?.status === 'cancelled'
                    ? 'cancelled'
                    : (event?.success ? 'success' : 'failure'));
            writeState({
                status: nextStatus,
                result: {
                    runId: String(event?.runId || ''),
                    success: event?.success === true,
                    status: nextStatus
                },
                endedAt: Date.now()
            });
        }
    });

    const processPendingControl = () => {
        if (!fs.existsSync(controlPath)) {
            return;
        }
        const control = safeReadJson(controlPath);
        const updatedAt = Number(control?.updatedAt || 0);
        const requestId = String(control?.requestId || '').trim();
        const requestIdentity = requestId || `${updatedAt}:${String(control?.action || '').trim()}`;
        if (!requestIdentity || requestIdentity === lastControlRequestId) {
            return;
        }
        lastControlRequestId = requestIdentity;
        if (['success', 'failure', 'cancelled'].includes(state.status)) return;
        const action = String(control?.action || '').trim();
        const targetRunId = String(rootRunId || args.runId).trim();

        if (action === 'pause') {
            pauseRequested = true;
            writeState({
                pauseRequested: true,
                status: 'pause_requested',
                lastControl: 'pause'
            });
            appendEvent('run.pause_requested', {
                action: 'pause',
                checkpointEveryNodes: state.checkpointEveryNodes
            }, targetRunId);
            return;
        }
        if (action === 'resume') {
            pauseRequested = false;
            pauseApplied = false;
            if (rootRunId) runtime.resume(rootRunId);
            writeState({
                pauseRequested: false,
                status: 'running',
                lastControl: 'resume'
            });
            appendEvent('run.resume_requested', { action: 'resume' }, targetRunId);
            return;
        }
        if (action === 'cancel' || action === 'stop') {
            cancelRequested = true;
            if (rootRunId) runtime.cancel(rootRunId);
            writeState({
                cancelRequested: true,
                status: 'cancel_requested',
                lastControl: 'cancel'
            });
            appendEvent('run.cancel_requested', { action: 'cancel' }, targetRunId);
        }
    };

    processPendingControl();
    const timer = setInterval(processPendingControl, 250);

    try {
        if (cancelRequested) {
            writeState({
                cancelRequested: true,
                status: 'cancelled',
                result: { success: false, status: 'cancelled' },
                endedAt: Date.now()
            });
            appendEvent('run.worker_finished', { status: 'cancelled', success: false }, args.runId);
            process.exitCode = 1;
            return;
        }
        const result = await runtime.run_pipeline_data(pipelineData, {
            dryRun: args.dryRun,
            from: args.from
        });
        const nextStatus: RunStatus = state.cancelRequested
            ? 'cancelled'
            : (result?.status === 'cancelled'
                ? 'cancelled'
                : (result?.success ? 'success' : 'failure'));
        writeState({
            status: nextStatus,
            result: projectRunResult(result),
            endedAt: Date.now()
        });
        appendEvent('run.worker_finished', {
            status: nextStatus,
            success: result?.success === true
        }, String(result?.runId || state.pipelineRunId || args.runId));
        process.exitCode = nextStatus === 'success' ? 0 : 1;
    } catch (error: any) {
        const sanitizedError = sanitizeWorkerError(error);
        writeState({
            status: state.cancelRequested ? 'cancelled' : 'failure',
            errorCode: sanitizedError.code,
            error: sanitizedError.message,
            result: undefined,
            endedAt: Date.now()
        });
        appendEvent('run.worker_error', { code: sanitizedError.code }, state.pipelineRunId || args.runId);
        process.exitCode = 1;
    } finally {
        clearInterval(timer);
        try {
            subscription.dispose();
        } catch {
            // noop
        }
    }
}

main().catch((error: any) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exit(1);
});
