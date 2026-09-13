import * as fs from 'fs';
import * as path from 'path';
import { CoreRuntime } from '../coreRuntime';
import { pipelineEventBus } from '../eventBus';
import { readPipelineSource } from '../pipelineSource';
import {
    appendEventRecord,
    cancelFilePath,
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
    try {
        appendEventRecord(eventsPath, {
            eventVersion: 1,
            ts: now,
            runId: state.detachedRunId,
            type: 'run.worker_error',
            payload: { code }
        });
    } catch {
        // Observability must not prevent publishing the terminal state.
    }
    writeJsonFile(statePath, {
        ...state,
        status: 'failure',
        errorCode: code,
        error: message,
        endedAt: now,
        updatedAt: now
    });
    throw Object.assign(new Error(message), { code });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const statePath = stateFilePath(args.workspaceRoot, args.runId);
    const controlPath = ctrlFilePath(args.workspaceRoot, args.runId);
    const cancellationPath = cancelFilePath(args.workspaceRoot, args.runId);
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

    let pipelineSource;
    try {
        pipelineSource = readPipelineSource(args.workspaceRoot, args.pipelinePath);
    } catch {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_CHANGED', 'Pipeline path or content changed before execution.');
    }
    const pipelinePath = pipelineSource.path;
    let persistedPipelinePath: string;
    try {
        persistedPipelinePath = fs.realpathSync.native(String(state.pipelinePath || ''));
    } catch {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_CHANGED', 'Pipeline path changed before execution.');
    }
    if (pipelinePath !== persistedPipelinePath) {
        failBeforeRuntime(statePath, eventsPath, state, 'RUN_PIPELINE_CHANGED', 'Pipeline path changed before execution.');
    }

    const pipelineBytes = pipelineSource.bytes;
    const actualHash = pipelineSource.contentHash;
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
        pipelinePath,
        from: args.from,
        dryRun: args.dryRun
    }, args.runId);

    let cancelRequested = state.cancelRequested === true || fs.existsSync(cancellationPath);
    let pauseRequested = !cancelRequested && (state.pauseRequested === true || state.status === 'pause_requested');
    let pauseApplied = !cancelRequested && state.status === 'paused';
    let rootRunId = String(state.pipelineRunId || '').trim() || undefined;
    let completedSteps = 0;
    let lastControlRequestId = String(state.lastControlRequestId || '').trim();

    const writeState = (patch?: Partial<DetachedRunState>): boolean => {
        if (['success', 'failure', 'cancelled'].includes(state.status)) return false;
        const durableState = safeReadJson(statePath) as DetachedRunState | undefined;
        if (durableState && ['success', 'failure', 'cancelled'].includes(durableState.status)) {
            state = durableState;
            return false;
        }
        state = {
            ...state,
            ...(patch || {}),
            updatedAt: Date.now()
        };
        writeJsonFile(statePath, state);
        return true;
    };

    const subscription = pipelineEventBus.on((event: any) => {
        const eventRunId = String(event?.runId || '').trim() || undefined;
        appendEvent(String(event?.type || 'unknown'), event, eventRunId);

        if (event?.type === 'pipelineStart') {
            if (rootRunId && eventRunId !== rootRunId) return;
            rootRunId = eventRunId || rootRunId;
            if (cancelRequested && rootRunId) {
                writeState({
                    pipelineRunId: rootRunId,
                    pauseRequested: false,
                    cancelRequested: true,
                    status: 'cancel_requested'
                });
                runtime.cancel(rootRunId);
            } else if (pauseRequested && rootRunId) {
                writeState({
                    pipelineRunId: rootRunId,
                    pauseRequested: true,
                    status: 'pause_requested'
                });
                runtime.pause(rootRunId);
            } else {
                writeState({
                    pipelineRunId: rootRunId || state.pipelineRunId,
                    status: 'running'
                });
            }
            return;
        }

        if (!rootRunId || eventRunId !== rootRunId) return;

        if (event?.type === 'stepEnd') {
            completedSteps += 1;
            const checkpointEveryNodes = toPositiveInt(state.checkpointEveryNodes, 1);
            if (cancelRequested) {
                runtime.cancel(rootRunId);
                return;
            }
            if (pauseRequested && !pauseApplied && completedSteps % checkpointEveryNodes === 0) {
                const targetRunId = String(state.pipelineRunId || args.runId).trim();
                runtime.pause(targetRunId);
                // CoreRuntime emits pipelinePause synchronously when it has
                // actually stopped between nodes. Only that event publishes
                // the durable paused state.
                if (pauseApplied && !cancelRequested) {
                    appendEvent('run.paused_checkpoint', {
                        stepId: String(event?.stepId || '').trim() || undefined,
                        completedSteps,
                        checkpointEveryNodes
                    }, targetRunId);
                }
            }
            return;
        }

        if (event?.type === 'pipelinePause') {
            if (cancelRequested) {
                runtime.cancel(rootRunId);
                return;
            }
            pauseApplied = true;
            pauseRequested = false;
            writeState({
                pauseRequested: false,
                status: 'paused'
            });
            return;
        }

        if (event?.type === 'pipelineResume') {
            if (cancelRequested) {
                runtime.cancel(rootRunId);
                return;
            }
            pauseApplied = false;
            writeState({ pauseRequested: false, status: 'running' });
            return;
        }

        // pipelineEnd remains journaled above. The worker publishes its final
        // event before making the root state terminal after run_pipeline_data
        // returns, so a terminal-state observer can drain a complete journal.
    });

    const applyCancellation = (control: any) => {
        if (['success', 'failure', 'cancelled'].includes(state.status)) return;
        const updatedAt = Number(control?.updatedAt || 0);
        const requestId = String(control?.requestId || '').trim();
        const requestIdentity = requestId || `${updatedAt}:cancel`;
        const firstApplication = !cancelRequested || state.status !== 'cancel_requested';
        cancelRequested = true;
        pauseRequested = false;
        pauseApplied = false;
        if (requestIdentity) lastControlRequestId = requestIdentity;
        writeState({
            pauseRequested: false,
            cancelRequested: true,
            status: 'cancel_requested',
            lastControl: 'cancel',
            ...(lastControlRequestId ? { lastControlRequestId } : {})
        });
        const targetRunId = String(rootRunId || args.runId).trim();
        if (firstApplication) {
            appendEvent('run.cancel_requested', { action: 'cancel' }, targetRunId);
        }
        if (rootRunId) runtime.cancel(rootRunId);
    };

    const processPendingControl = () => {
        // This write-once marker is checked first. It makes cancellation
        // dominant even if a concurrent pause/resume replaces ctrl.json.
        const durableCancellation = fs.existsSync(cancellationPath)
            ? safeReadJson(cancellationPath)
            : undefined;
        if (durableCancellation || cancelRequested || state.cancelRequested === true) {
            applyCancellation(durableCancellation || { requestId: state.lastControlRequestId, updatedAt: state.updatedAt });
            return;
        }
        if (!fs.existsSync(controlPath)) return;

        const control = safeReadJson(controlPath);
        const updatedAt = Number(control?.updatedAt || 0);
        const requestId = String(control?.requestId || '').trim();
        const action = String(control?.action || '').trim();
        const requestIdentity = requestId || `${updatedAt}:${action}`;
        if (!requestIdentity || requestIdentity === lastControlRequestId) return;
        if (['success', 'failure', 'cancelled'].includes(state.status)) return;
        const targetRunId = String(rootRunId || args.runId).trim();

        if (action === 'cancel' || action === 'stop') {
            applyCancellation(control);
            return;
        }
        if (action === 'pause') {
            lastControlRequestId = requestIdentity;
            if (pauseApplied || state.status === 'paused') {
                pauseRequested = false;
                writeState({
                    pauseRequested: false,
                    status: 'paused',
                    lastControl: 'pause',
                    lastControlRequestId
                });
                return;
            }
            pauseRequested = true;
            writeState({
                pauseRequested: true,
                status: 'pause_requested',
                lastControl: 'pause',
                lastControlRequestId
            });
            appendEvent('run.pause_requested', {
                action: 'pause',
                checkpointEveryNodes: state.checkpointEveryNodes
            }, targetRunId);
            return;
        }
        if (action === 'resume') {
            lastControlRequestId = requestIdentity;
            pauseRequested = false;
            appendEvent('run.resume_requested', { action: 'resume' }, targetRunId);
            if (pauseApplied && rootRunId) {
                // Keep the public state paused until pipelineResume confirms
                // that the runner has actually woken up.
                writeState({
                    pauseRequested: false,
                    status: 'paused',
                    lastControl: 'resume',
                    lastControlRequestId
                });
                runtime.resume(rootRunId);
                return;
            }
            pauseApplied = false;
            writeState({
                pauseRequested: false,
                status: rootRunId ? 'running' : 'starting',
                lastControl: 'resume',
                lastControlRequestId
            });
        }
    };

    processPendingControl();
    const timer = setInterval(processPendingControl, 250);
    const cancellationIsDurable = () => (
        cancelRequested
        || state.cancelRequested === true
        || fs.existsSync(cancellationPath)
    );

    try {
        if (cancelRequested) {
            appendEvent('run.worker_finished', { status: 'cancelled', success: false }, args.runId);
            writeState({
                cancelRequested: true,
                status: 'cancelled',
                result: { success: false, status: 'cancelled' },
                endedAt: Date.now()
            });
            process.exitCode = 1;
            return;
        }
        const result = await runtime.run_pipeline_data(pipelineData, {
            dryRun: args.dryRun,
            from: args.from
        });
        const nextStatus: RunStatus = result?.status === 'cancelled'
            ? 'cancelled'
            : (result?.success ? 'success' : 'failure');
        // This is the terminal-transition linearization point. It closes the
        // window after the last timer poll while preserving event-before-state
        // ordering for observers.
        const finalStatus: RunStatus = cancellationIsDurable() ? 'cancelled' : nextStatus;
        appendEvent('run.worker_finished', {
            status: finalStatus,
            success: finalStatus === 'success'
        }, String(result?.runId || state.pipelineRunId || args.runId));
        writeState({
            status: finalStatus,
            cancelRequested: finalStatus === 'cancelled' ? true : state.cancelRequested,
            result: finalStatus === 'cancelled'
                ? { ...(result?.runId ? { runId: String(result.runId) } : {}), success: false, status: 'cancelled' }
                : projectRunResult(result),
            endedAt: Date.now()
        });
        process.exitCode = finalStatus === 'success' ? 0 : 1;
    } catch (error: any) {
        if (cancellationIsDurable()) {
            appendEvent('run.worker_finished', { status: 'cancelled', success: false }, state.pipelineRunId || args.runId);
            writeState({
                status: 'cancelled',
                pauseRequested: false,
                cancelRequested: true,
                errorCode: undefined,
                error: undefined,
                result: {
                    ...(state.pipelineRunId ? { runId: state.pipelineRunId } : {}),
                    success: false,
                    status: 'cancelled'
                },
                endedAt: Date.now()
            });
            process.exitCode = 1;
            return;
        }
        const sanitizedError = sanitizeWorkerError(error);
        appendEvent('run.worker_error', { code: sanitizedError.code }, state.pipelineRunId || args.runId);
        writeState({
            status: 'failure',
            errorCode: sanitizedError.code,
            error: sanitizedError.message,
            result: undefined,
            endedAt: Date.now()
        });
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
