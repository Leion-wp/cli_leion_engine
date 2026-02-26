import * as fs from 'fs';
import { CoreRuntime } from '../coreRuntime';
import {
    appendEventRecord,
    ctrlFilePath,
    eventsFilePath,
    stateFilePath,
    writeJsonFile,
    DetachedRunState,
    RunStatus
} from './runSupervisorService';

type WorkerArgs = {
    workspaceRoot: string;
    runId: string;
    pipeline: string;
    pipelinePath: string;
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
    if (!workspaceRoot || !runId || !pipeline || !pipelinePath) {
        throw new Error('runSupervisorWorker requires --workspace --run_id --pipeline --pipeline_path');
    }
    return {
        workspaceRoot,
        runId,
        pipeline,
        pipelinePath,
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

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const statePath = stateFilePath(args.workspaceRoot, args.runId);
    const controlPath = ctrlFilePath(args.workspaceRoot, args.runId);
    const eventsPath = eventsFilePath(args.workspaceRoot, args.runId);

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

    let state = (safeReadJson(statePath) || {}) as DetachedRunState;
    state.detachedRunId = args.runId;
    state.workspaceRoot = args.workspaceRoot;
    state.pipeline = args.pipeline;
    state.pipelinePath = args.pipelinePath;
    state.from = args.from;
    state.dryRun = args.dryRun;
    state.status = state.status || 'starting';
    state.startedAt = Number(state.startedAt || Date.now());
    state.updatedAt = Date.now();
    state.checkpointEveryNodes = toPositiveInt(
        state.checkpointEveryNodes,
        loadCheckpointEveryNodes(args.workspaceRoot, 1)
    );
    writeJsonFile(statePath, state);

    const appendEvent = (type: string, payload: any, runIdOverride?: string) => {
        const eventRunId = String(runIdOverride || state.pipelineRunId || args.runId || '').trim() || args.runId;
        appendEventRecord(eventsPath, {
            eventVersion: 1,
            ts: Date.now(),
            runId: eventRunId,
            type,
            payload
        });
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
    let completedSteps = 0;
    let lastControlTimestamp = 0;

    const writeState = (patch?: Partial<DetachedRunState>) => {
        state = {
            ...state,
            ...(patch || {}),
            updatedAt: Date.now()
        };
        writeJsonFile(statePath, state);
    };

    const subscription = runtime.on_event((event: any) => {
        appendEvent(String(event?.type || 'unknown'), event, String(event?.runId || '').trim() || undefined);

        if (event?.type === 'pipelineStart') {
            writeState({
                pipelineRunId: String(event?.runId || '').trim() || state.pipelineRunId,
                status: 'running'
            });
            return;
        }

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
            const nextStatus: RunStatus = state.cancelRequested
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

    const timer = setInterval(() => {
        if (!fs.existsSync(controlPath)) {
            return;
        }
        const control = safeReadJson(controlPath);
        const updatedAt = Number(control?.updatedAt || 0);
        if (!Number.isFinite(updatedAt) || updatedAt <= lastControlTimestamp) {
            return;
        }
        lastControlTimestamp = updatedAt;
        const action = String(control?.action || '').trim();
        const targetRunId = String(state.pipelineRunId || args.runId).trim();

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
            runtime.resume(targetRunId);
            writeState({
                pauseRequested: false,
                status: 'running',
                lastControl: 'resume'
            });
            appendEvent('run.resume_requested', { action: 'resume' }, targetRunId);
            return;
        }
        if (action === 'cancel' || action === 'stop') {
            runtime.cancel(targetRunId);
            writeState({
                cancelRequested: true,
                status: 'cancel_requested',
                lastControl: 'cancel'
            });
            appendEvent('run.cancel_requested', { action: 'cancel' }, targetRunId);
        }
    }, 250);

    try {
        const result = await runtime.run_pipeline_file(args.pipelinePath, {
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
            result,
            endedAt: Date.now()
        });
        appendEvent('run.worker_finished', {
            status: nextStatus,
            success: result?.success === true
        }, String(result?.runId || state.pipelineRunId || args.runId));
        process.exit(nextStatus === 'success' ? 0 : 1);
    } catch (error: any) {
        const message = String(error?.message || error || 'Unknown detached worker failure');
        writeState({
            status: state.cancelRequested ? 'cancelled' : 'failure',
            error: message,
            endedAt: Date.now()
        });
        appendEvent('run.worker_error', { message }, state.pipelineRunId || args.runId);
        process.exit(1);
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
