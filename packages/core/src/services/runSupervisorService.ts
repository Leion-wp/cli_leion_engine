import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { PipelineCatalogService } from './pipelineCatalogService';
import { getConfigValue } from './config';

export type RunStatus =
    | 'starting'
    | 'running'
    | 'pause_requested'
    | 'paused'
    | 'cancel_requested'
    | 'success'
    | 'failure'
    | 'cancelled';

export type DetachedRunState = {
    detachedRunId: string;
    workspaceRoot: string;
    pipeline: string;
    pipelinePath?: string;
    from?: string;
    dryRun: boolean;
    status: RunStatus;
    startedAt: number;
    updatedAt: number;
    endedAt?: number;
    pid?: number;
    pipelineRunId?: string;
    pauseRequested?: boolean;
    checkpointEveryNodes?: number;
    cancelRequested?: boolean;
    lastControl?: 'pause' | 'resume' | 'cancel';
    error?: string;
    result?: any;
};

export type RunControlAction = 'pause' | 'resume' | 'cancel';

export type RunEventRecord = {
    eventVersion: 1;
    ts: number;
    runId: string;
    type: string;
    payload: any;
};

type StartDetachedOptions = {
    pipeline: string;
    from?: string;
    dryRun?: boolean;
    verbose?: boolean;
};

function safeReadJson(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

export function getRunsDir(workspaceRoot: string): string {
    const dir = path.join(workspaceRoot, '.intent-router', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function stateFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${detachedRunId}.json`);
}

export function ctrlFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${detachedRunId}.ctrl.json`);
}

export function eventsFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${detachedRunId}.events.ndjson`);
}

export function writeJsonFile(filePath: string, value: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function appendEventRecord(filePath: string, record: RunEventRecord): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function generateDetachedRunId(): string {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePositiveInt(input: any, fallback: number): number {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

export class RunSupervisorService {
    private readonly catalog: PipelineCatalogService;

    constructor(private readonly workspaceRoot: string) {
        this.catalog = new PipelineCatalogService(workspaceRoot);
    }

    private runStateFiles(): string[] {
        const dir = getRunsDir(this.workspaceRoot);
        return fs
            .readdirSync(dir)
            .filter((entry) => entry.endsWith('.json') && !entry.endsWith('.ctrl.json'))
            .map((entry) => path.join(dir, entry));
    }

    private checkpointEveryNodes(): number {
        return normalizePositiveInt(
            getConfigValue(this.workspaceRoot, 'intentRouter.runtime.checkpoint.everyNodes', 1),
            1
        );
    }

    list_runs(): DetachedRunState[] {
        const rows: DetachedRunState[] = [];
        for (const filePath of this.runStateFiles()) {
            const parsed = safeReadJson(filePath);
            if (!parsed || typeof parsed !== 'object') continue;
            rows.push(parsed as DetachedRunState);
        }
        return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    show_run(runId: string): DetachedRunState | undefined {
        const normalized = String(runId || '').trim();
        if (!normalized) return undefined;
        return this.list_runs().find((entry) => {
            return (
                String(entry.detachedRunId || '') === normalized
                || String(entry.pipelineRunId || '') === normalized
            );
        });
    }

    private resolveDetachedRunId(runId: string): string {
        const state = this.show_run(runId);
        if (!state) {
            throw new Error(`Run not found for id: ${runId}`);
        }
        return String(state.detachedRunId || '').trim();
    }

    private writeControl(runId: string, action: RunControlAction): { run_id: string; detached_run_id: string; action: RunControlAction } {
        const requestedRunId = String(runId || '').trim();
        if (!requestedRunId) {
            throw new Error('runId is required.');
        }
        const detachedRunId = this.resolveDetachedRunId(requestedRunId);
        writeJsonFile(ctrlFilePath(this.workspaceRoot, detachedRunId), {
            action,
            requestedRunId,
            updatedAt: Date.now()
        });

        const statePath = stateFilePath(this.workspaceRoot, detachedRunId);
        const state = (safeReadJson(statePath) || {}) as DetachedRunState;
        state.updatedAt = Date.now();
        state.lastControl = action;
        if (action === 'pause') {
            state.pauseRequested = true;
            state.status = 'pause_requested';
        } else if (action === 'resume') {
            state.pauseRequested = false;
            state.status = 'running';
        } else if (action === 'cancel') {
            state.cancelRequested = true;
            state.status = 'cancel_requested';
        }
        writeJsonFile(statePath, state);

        return { run_id: requestedRunId, detached_run_id: detachedRunId, action };
    }

    pause_run(runId: string): { run_id: string; detached_run_id: string; action: RunControlAction } {
        return this.writeControl(runId, 'pause');
    }

    resume_run(runId: string): { run_id: string; detached_run_id: string; action: RunControlAction } {
        return this.writeControl(runId, 'resume');
    }

    cancel_run(runId: string): { run_id: string; detached_run_id: string; action: RunControlAction } {
        return this.writeControl(runId, 'cancel');
    }

    start_detached(options: StartDetachedOptions): { run_id: string; pid?: number; status: RunStatus } {
        const pipeline = String(options.pipeline || '').trim();
        if (!pipeline) {
            throw new Error('start_detached requires pipeline.');
        }
        const detachedRunId = generateDetachedRunId();
        const pipelinePath = this.catalog.resolvePipelinePath(pipeline);
        const checkpointEveryNodes = this.checkpointEveryNodes();
        const state: DetachedRunState = {
            detachedRunId,
            workspaceRoot: this.workspaceRoot,
            pipeline,
            pipelinePath,
            from: String(options.from || '').trim() || undefined,
            dryRun: options.dryRun === true,
            status: 'starting',
            startedAt: Date.now(),
            updatedAt: Date.now(),
            checkpointEveryNodes
        };
        writeJsonFile(stateFilePath(this.workspaceRoot, detachedRunId), state);

        appendEventRecord(eventsFilePath(this.workspaceRoot, detachedRunId), {
            eventVersion: 1,
            ts: Date.now(),
            runId: detachedRunId,
            type: 'run.detached_started',
            payload: {
                detachedRunId,
                pipeline,
                pipelinePath,
                from: state.from,
                dryRun: state.dryRun,
                checkpointEveryNodes
            }
        });

        const workerEntry = path.resolve(__dirname, 'runSupervisorWorker.js');
        const args = [
            workerEntry,
            '--workspace', this.workspaceRoot,
            '--run_id', detachedRunId,
            '--pipeline', pipeline,
            '--pipeline_path', pipelinePath
        ];
        if (state.from) args.push('--from', state.from);
        if (state.dryRun) args.push('--dry_run');
        if (options.verbose) args.push('--verbose');

        const child = cp.spawn(process.execPath, args, {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore'
        });
        child.unref();

        state.pid = child.pid;
        state.updatedAt = Date.now();
        writeJsonFile(stateFilePath(this.workspaceRoot, detachedRunId), state);
        return { run_id: detachedRunId, pid: child.pid, status: 'starting' };
    }

    tail_events(runId: string, cursor?: number): { events: RunEventRecord[]; nextCursor: number } {
        const state = this.show_run(runId);
        if (!state) {
            throw new Error(`Run not found for id: ${runId}`);
        }
        const detachedRunId = String(state.detachedRunId || '').trim();
        const filePath = eventsFilePath(this.workspaceRoot, detachedRunId);
        if (!fs.existsSync(filePath)) {
            return { events: [], nextCursor: 0 };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const from = Math.max(0, Math.floor(Number(cursor || 0)));
        const parsed: RunEventRecord[] = [];
        for (let index = from; index < lines.length; index += 1) {
            try {
                const row = JSON.parse(lines[index]);
                if (row && row.eventVersion === 1) {
                    parsed.push(row as RunEventRecord);
                }
            } catch {
                // ignore malformed lines
            }
        }
        const maxItems = normalizePositiveInt(
            getConfigValue(this.workspaceRoot, 'intentRouter.tui.events.maxItems', 5000),
            5000
        );
        const events = parsed.length > maxItems ? parsed.slice(parsed.length - maxItems) : parsed;
        return {
            events,
            nextCursor: lines.length
        };
    }
}

