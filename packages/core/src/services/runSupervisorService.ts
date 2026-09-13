import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { createHash, randomBytes } from 'crypto';

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
    correlationId?: string;
    requestFingerprint?: string;
    workspaceRoot: string;
    pipeline: string;
    pipelinePath?: string;
    pipelineHash?: string;
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
    errorCode?: string;
    orphanedStatus?: RunStatus;
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

export type StartDetachedOptions = {
    pipeline: string;
    from?: string;
    dryRun?: boolean;
    verbose?: boolean;
    correlationId?: string;
};

export type StartDetachedResult = {
    run_id: string;
    detached_run_id: string;
    correlation_id?: string;
    pid?: number;
    status: RunStatus | 'detached';
    reused: boolean;
    recovered?: boolean;
};

export type RunSupervisorDependencies = {
    spawn?: typeof cp.spawn;
    now?: () => number;
    generateRunId?: () => string;
    isProcessAlive?: (pid: number) => boolean;
    persistState?: (filePath: string, state: DetachedRunState) => void;
};

type CorrelationClaim = {
    claimVersion: 1;
    correlationId: string;
    requestFingerprint: string;
    detachedRunId: string;
    createdAt: number;
};

type ProcessClaim = {
    claimVersion: 1;
    ownerPid: number;
    createdAt: number;
};

const TERMINAL_STATUSES = new Set<RunStatus>(['success', 'failure', 'cancelled']);
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^run_[a-z0-9_]+$/;
export const STARTING_STATUS_GRACE_MS = 5000;

export class RunSupervisorError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'RunSupervisorError';
    }
}

function sleepSync(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isWithin(parentPath: string, candidatePath: string): boolean {
    const relative = path.relative(parentPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalExistingPath(inputPath: string, code: string, label: string): string {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        throw new RunSupervisorError(code, `${label} does not exist: ${resolved}`);
    }
}

function ensurePlainDirectory(parentPath: string, name: string): string {
    const candidate = path.join(parentPath, name);
    try {
        fs.mkdirSync(candidate);
    } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RunSupervisorError('RUN_STORAGE_UNSAFE', `Run storage component is not a plain directory: ${candidate}`);
    }
    const realCandidate = fs.realpathSync.native(candidate);
    if (!isWithin(parentPath, realCandidate)) {
        throw new RunSupervisorError('RUN_STORAGE_UNSAFE', `Run storage escapes the workspace: ${candidate}`);
    }
    return realCandidate;
}

function safeReadJson(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function fsyncParentDirectory(filePath: string): void {
    const ignoredCodes = new Set(['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP']);
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(path.dirname(filePath), 'r');
        fs.fsyncSync(descriptor);
    } catch (error: any) {
        if (!ignoredCodes.has(String(error?.code || ''))) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* noop */ }
        }
    }
}

function validateRunId(detachedRunId: string): string {
    const normalized = String(detachedRunId || '').trim();
    if (!RUN_ID_PATTERN.test(normalized)) {
        throw new RunSupervisorError('RUN_ID_INVALID', 'Detached run id is invalid.');
    }
    return normalized;
}

export function validateCorrelationId(correlationId: string): string {
    const normalized = String(correlationId || '').trim();
    if (!CORRELATION_PATTERN.test(normalized)) {
        throw new RunSupervisorError(
            'RUN_CORRELATION_INVALID',
            'correlation_id must be 1-128 characters and contain only letters, numbers, dot, underscore, colon, or hyphen.'
        );
    }
    return normalized;
}

export function getRunsDir(workspaceRoot: string): string {
    const canonicalRoot = canonicalExistingPath(workspaceRoot, 'WORKSPACE_NOT_FOUND', 'Workspace');
    const intentRouterDir = ensurePlainDirectory(canonicalRoot, '.intent-router');
    return ensurePlainDirectory(intentRouterDir, 'runs');
}

export function stateFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.json`);
}

export function ctrlFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.ctrl.json`);
}

export function eventsFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.events.ndjson`);
}

export function executionClaimFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.execution.claim`);
}

function spawnClaimFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.spawn.claim`);
}

export function waitForSpawnClaimRelease(workspaceRoot: string, detachedRunId: string): void {
    const claimPath = spawnClaimFilePath(workspaceRoot, detachedRunId);
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (!fs.existsSync(claimPath)) return;
        const claim = safeReadJson(claimPath) as ProcessClaim | undefined;
        if (claim && !defaultIsProcessAlive(Number(claim.ownerPid))) {
            try { fs.unlinkSync(claimPath); } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error;
            }
            return;
        }
        sleepSync(10);
    }
    throw new RunSupervisorError('RUN_SPAWN_CLAIM_TIMEOUT', 'Timed out waiting for detached run state handoff.');
}

function correlationsDir(workspaceRoot: string): string {
    return ensurePlainDirectory(getRunsDir(workspaceRoot), 'correlations');
}

export function correlationClaimFilePath(workspaceRoot: string, correlationId: string): string {
    const normalized = validateCorrelationId(correlationId);
    const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
    return path.join(correlationsDir(workspaceRoot), `${digest}.claim.json`);
}

export function writeJsonFile(filePath: string, value: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    );
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fsyncParentDirectory(filePath);
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* noop */ }
        }
        try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* noop */ }
    }
}

function writeExclusiveJson(filePath: string, value: any): boolean {
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.claim.tmp`
    );
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        try {
            fs.linkSync(temporaryPath, filePath);
            fsyncParentDirectory(filePath);
            return true;
        } catch (error: any) {
            if (error?.code === 'EEXIST') return false;
            throw error;
        }
    } catch (error: any) {
        throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* noop */ }
        }
        try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* noop */ }
    }
}

function quarantineCorruptClaim(filePath: string): boolean {
    const quarantinePath = `${filePath}.corrupt.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
        fs.renameSync(filePath, quarantinePath);
        return true;
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return false;
        throw error;
    }
}

export function appendEventRecord(filePath: string, record: RunEventRecord): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const sanitizedRecord = {
        ...record,
        payload: projectRunEventPayload(record.type, record.payload)
    };
    fs.appendFileSync(filePath, `${JSON.stringify(sanitizedRecord)}\n`, { encoding: 'utf8', mode: 0o600 });
}

const EVENT_PAYLOAD_FIELDS = [
    'runId', 'intentId', 'nodeId', 'stepId', 'index', 'timestamp', 'success',
    'status', 'totalSteps', 'stream', 'action',
    'completedSteps', 'checkpointEveryNodes', 'detachedRunId', 'correlationId',
    'dryRun', 'code'
] as const;

export function projectRunEventPayload(eventType: string, value: any): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const projected: Record<string, any> = {};
    for (const key of EVENT_PAYLOAD_FIELDS) {
        const entry = value[key];
        if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
            projected[key] = entry;
        }
    }
    if (eventType === 'stepLog' && typeof value.text === 'string') {
        projected.textLength = Buffer.byteLength(value.text, 'utf8');
        projected.textSha256 = createHash('sha256').update(value.text, 'utf8').digest('hex');
    }
    return projected;
}

export function projectRunResult(value: any): { runId?: string; success: boolean; status: RunStatus } {
    const rawStatus = String(value?.status || '').trim();
    const status: RunStatus = ['success', 'failure', 'cancelled'].includes(rawStatus)
        ? rawStatus as RunStatus
        : (value?.success === true ? 'success' : 'failure');
    const runId = String(value?.runId || '').trim() || undefined;
    return { ...(runId ? { runId } : {}), success: value?.success === true, status };
}

export function sanitizeWorkerError(error: any): { code: string; message: string } {
    const rawCode = String(error?.code || '').trim();
    const code = ['INTERACTION_REQUIRED', 'RUN_PIPELINE_CHANGED', 'RUN_PIPELINE_INVALID'].includes(rawCode)
        ? rawCode
        : 'RUN_WORKER_FAILED';
    const message = code === 'INTERACTION_REQUIRED'
        ? 'INTERACTION_REQUIRED: Detached worker requires interaction.'
        : code === 'RUN_PIPELINE_CHANGED'
            ? 'Pipeline content changed before execution.'
            : code === 'RUN_PIPELINE_INVALID'
                ? 'Pipeline content is not valid JSON.'
                : 'Detached worker failed.';
    return { code, message };
}

function generateDetachedRunId(): string {
    return `run_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

function normalizePositiveInt(input: any, fallback: number): number {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function defaultIsProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === 'EPERM';
    }
}

function readClaimWithRetry(filePath: string): any | undefined {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const claim = safeReadJson(filePath);
        if (claim) return claim;
        sleepSync(10);
    }
    return undefined;
}

function requestFingerprint(input: {
    workspaceRoot: string;
    pipelinePath: string;
    pipelineHash: string;
    from?: string;
    dryRun: boolean;
}): string {
    const canonical = JSON.stringify({
        workspaceRoot: input.workspaceRoot,
        pipelinePath: input.pipelinePath,
        pipelineHash: input.pipelineHash,
        from: input.from || null,
        dryRun: input.dryRun
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function resolvePipelinePath(workspaceRoot: string, pipelineRef: string): string {
    const raw = String(pipelineRef || '').trim();
    if (!raw) throw new RunSupervisorError('PIPELINE_REQUIRED', 'Pipeline reference is required.');
    const withExtension = raw.endsWith('.intent.json') ? raw : `${raw}.intent.json`;
    if (path.isAbsolute(withExtension)) return path.resolve(withExtension);
    if (withExtension.includes('/') || withExtension.includes('\\')) {
        return path.resolve(workspaceRoot, withExtension);
    }
    return path.resolve(workspaceRoot, 'pipeline', withExtension);
}

export function tryAcquireExecutionClaim(workspaceRoot: string, detachedRunId: string): boolean {
    const claimPath = executionClaimFilePath(workspaceRoot, detachedRunId);
    const statePath = stateFilePath(workspaceRoot, detachedRunId);
    const processClaim: ProcessClaim = { claimVersion: 1, ownerPid: process.pid, createdAt: Date.now() };
    if (writeExclusiveJson(claimPath, processClaim)) return true;

    const state = safeReadJson(statePath) as DetachedRunState | undefined;
    if (state && TERMINAL_STATUSES.has(state.status)) return false;
    const existing = readClaimWithRetry(claimPath) as ProcessClaim | undefined;
    if (!existing || existing.claimVersion !== 1 || !Number.isSafeInteger(Number(existing.ownerPid))) {
        if (!state || state.status !== 'starting' || !quarantineCorruptClaim(claimPath)) return false;
        return writeExclusiveJson(claimPath, processClaim);
    }
    if (defaultIsProcessAlive(Number(existing.ownerPid))) return false;
    if (!state || state.status !== 'starting') return false;

    try { fs.unlinkSync(claimPath); } catch (error: any) {
        if (error?.code !== 'ENOENT') return false;
    }
    return writeExclusiveJson(claimPath, processClaim);
}

export class RunSupervisorService {
    private readonly workspaceRoot: string;
    private readonly spawnProcess: typeof cp.spawn;
    private readonly now: () => number;
    private readonly generateRunId: () => string;
    private readonly isProcessAlive: (pid: number) => boolean;
    private readonly persistState: (filePath: string, state: DetachedRunState) => void;

    constructor(workspaceRoot: string, dependencies: RunSupervisorDependencies = {}) {
        this.workspaceRoot = canonicalExistingPath(workspaceRoot, 'WORKSPACE_NOT_FOUND', 'Workspace');
        this.spawnProcess = dependencies.spawn || cp.spawn;
        this.now = dependencies.now || (() => Date.now());
        this.generateRunId = dependencies.generateRunId || generateDetachedRunId;
        this.isProcessAlive = dependencies.isProcessAlive || defaultIsProcessAlive;
        this.persistState = dependencies.persistState || writeJsonFile;
    }

    private runStateFiles(): string[] {
        const runsDir = getRunsDir(this.workspaceRoot);
        return fs.readdirSync(runsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && RUN_ID_PATTERN.test(entry.name.replace(/\.json$/, '')))
            .map((entry) => path.join(runsDir, entry.name));
    }

    private checkpointEveryNodes(): number {
        const config = safeReadJson(path.join(this.workspaceRoot, '.intent-router', 'config.json'));
        return normalizePositiveInt(
            config?.intentRouter?.runtime?.checkpoint?.everyNodes
                ?? config?.['intentRouter.runtime.checkpoint.everyNodes'],
            1
        );
    }

    list_runs(): DetachedRunState[] {
        const rows: DetachedRunState[] = [];
        for (const filePath of this.runStateFiles()) {
            const parsed = safeReadJson(filePath);
            if (parsed && typeof parsed === 'object') rows.push(parsed as DetachedRunState);
        }
        return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    findRunState(identifier: string): DetachedRunState | undefined {
        const normalized = String(identifier || '').trim();
        if (!normalized) return undefined;
        return this.list_runs().find((entry) => (
            String(entry.detachedRunId || '') === normalized
            || String(entry.pipelineRunId || '') === normalized
            || String(entry.correlationId || '') === normalized
        ));
    }

    show_run(runId: string): DetachedRunState | undefined {
        return this.findRunState(runId);
    }

    private resolveDetachedRunId(runId: string): string {
        const state = this.findRunState(runId);
        if (!state) throw new RunSupervisorError('RUN_NOT_FOUND', `Run not found for id: ${runId}`);
        return validateRunId(state.detachedRunId);
    }

    private writeControl(runId: string, action: RunControlAction): {
        run_id: string;
        detached_run_id: string;
        correlation_id?: string;
        action: RunControlAction;
    } {
        const requestedRunId = String(runId || '').trim();
        if (!requestedRunId) throw new RunSupervisorError('RUN_ID_REQUIRED', 'runId is required.');
        const detachedRunId = this.resolveDetachedRunId(requestedRunId);
        const statePath = stateFilePath(this.workspaceRoot, detachedRunId);
        const persistedState = safeReadJson(statePath) as DetachedRunState | undefined;
        if (!persistedState) throw new RunSupervisorError('RUN_NOT_FOUND', `Run not found for id: ${runId}`);
        const state = this.getRunStatus(requestedRunId) || persistedState;
        if (TERMINAL_STATUSES.has(state.status)) {
            throw new RunSupervisorError(
                'RUN_CONTROL_INVALID_STATE',
                `Cannot ${action} a terminal detached run.`
            );
        }
        const updatedAt = this.now();
        const controlPath = ctrlFilePath(this.workspaceRoot, detachedRunId);
        const requestId = randomBytes(12).toString('hex');
        writeJsonFile(controlPath, { action, requestedRunId, requestId, updatedAt });
        const latest = safeReadJson(statePath) as DetachedRunState | undefined;
        if (latest && TERMINAL_STATUSES.has(latest.status)) {
            try { fs.unlinkSync(controlPath); } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error;
            }
            throw new RunSupervisorError(
                'RUN_CONTROL_INVALID_STATE',
                `Cannot ${action} a terminal detached run.`
            );
        }
        return {
            run_id: requestedRunId,
            detached_run_id: detachedRunId,
            ...(state.correlationId ? { correlation_id: state.correlationId } : {}),
            action
        };
    }

    pause_run(runId: string) { return this.writeControl(runId, 'pause'); }
    resume_run(runId: string) { return this.writeControl(runId, 'resume'); }
    cancel_run(runId: string) { return this.writeControl(runId, 'cancel'); }

    private newRunId(): string {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const candidate = validateRunId(this.generateRunId());
            if (!fs.existsSync(stateFilePath(this.workspaceRoot, candidate))) return candidate;
        }
        throw new RunSupervisorError('RUN_ID_EXHAUSTED', 'Could not allocate a unique detached run id.');
    }

    private claimCorrelation(correlationId: string, fingerprint: string): { claim: CorrelationClaim; created: boolean } {
        const claimPath = correlationClaimFilePath(this.workspaceRoot, correlationId);
        let proposed: CorrelationClaim = {
            claimVersion: 1,
            correlationId,
            requestFingerprint: fingerprint,
            detachedRunId: this.newRunId(),
            createdAt: this.now()
        };
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (writeExclusiveJson(claimPath, proposed)) return { claim: proposed, created: true };
            const existing = readClaimWithRetry(claimPath) as CorrelationClaim | undefined;
            if (
                existing?.claimVersion === 1
                && existing.correlationId === correlationId
                && RUN_ID_PATTERN.test(String(existing.detachedRunId || ''))
            ) {
                if (existing.requestFingerprint !== fingerprint) {
                    throw new RunSupervisorError(
                        'RUN_CORRELATION_CONFLICT',
                        'correlation_id is already bound to different immutable run parameters.'
                    );
                }
                return { claim: existing, created: false };
            }

            const existingState = this.findRunState(correlationId);
            if (existingState) {
                if (existingState.requestFingerprint !== fingerprint) {
                    throw new RunSupervisorError(
                        'RUN_CORRELATION_CONFLICT',
                        'correlation_id is already bound to different immutable run parameters.'
                    );
                }
                proposed = {
                    claimVersion: 1,
                    correlationId,
                    requestFingerprint: fingerprint,
                    detachedRunId: existingState.detachedRunId,
                    createdAt: existingState.startedAt
                };
            }
            quarantineCorruptClaim(claimPath);
        }
        throw new RunSupervisorError('RUN_CORRELATION_CLAIM_INVALID', 'The existing correlation claim could not be recovered.');
    }

    private acquireSpawnClaim(detachedRunId: string): boolean {
        const claimPath = spawnClaimFilePath(this.workspaceRoot, detachedRunId);
        const proposed: ProcessClaim = { claimVersion: 1, ownerPid: process.pid, createdAt: this.now() };
        if (writeExclusiveJson(claimPath, proposed)) return true;
        const existing = readClaimWithRetry(claimPath) as ProcessClaim | undefined;
        if (!existing || existing.claimVersion !== 1 || !Number.isSafeInteger(Number(existing.ownerPid))) {
            if (!quarantineCorruptClaim(claimPath)) return false;
            return writeExclusiveJson(claimPath, proposed);
        }
        if (this.isProcessAlive(Number(existing.ownerPid))) return false;
        try { fs.unlinkSync(claimPath); } catch (error: any) {
            if (error?.code !== 'ENOENT') return false;
        }
        return writeExclusiveJson(claimPath, proposed);
    }

    private activeExecutionPid(detachedRunId: string): number | undefined {
        const claimPath = executionClaimFilePath(this.workspaceRoot, detachedRunId);
        if (!fs.existsSync(claimPath)) return undefined;
        const claim = safeReadJson(claimPath) as ProcessClaim | undefined;
        const ownerPid = Number(claim?.ownerPid);
        return this.isProcessAlive(ownerPid) ? ownerPid : undefined;
    }

    private activeSpawnPid(detachedRunId: string): number | undefined {
        const claimPath = spawnClaimFilePath(this.workspaceRoot, detachedRunId);
        if (!fs.existsSync(claimPath)) return undefined;
        const claim = safeReadJson(claimPath) as ProcessClaim | undefined;
        const ownerPid = Number(claim?.ownerPid);
        return this.isProcessAlive(ownerPid) ? ownerPid : undefined;
    }

    getRunStatus(identifier: string): DetachedRunState | undefined {
        const state = this.findRunState(identifier);
        if (!state || TERMINAL_STATUSES.has(state.status)) return state;
        const executionPid = this.activeExecutionPid(state.detachedRunId);
        if ((state.pid && this.isProcessAlive(state.pid)) || executionPid || this.activeSpawnPid(state.detachedRunId)) {
            if (executionPid && state.pid !== executionPid) {
                return { ...state, pid: executionPid };
            }
            return state;
        }
        const now = this.now();
        const lastStartingActivity = Math.max(Number(state.startedAt || 0), Number(state.updatedAt || 0));
        if (state.status === 'starting' && now - lastStartingActivity < STARTING_STATUS_GRACE_MS) {
            return state;
        }
        const statePath = stateFilePath(this.workspaceRoot, state.detachedRunId);
        const latest = safeReadJson(statePath) as DetachedRunState | undefined;
        if (!latest) return state;
        if (TERMINAL_STATUSES.has(latest.status)) return latest;
        const latestExecutionPid = this.activeExecutionPid(latest.detachedRunId);
        if (
            (latest.pid && this.isProcessAlive(latest.pid))
            || latestExecutionPid
            || this.activeSpawnPid(latest.detachedRunId)
        ) {
            if (latestExecutionPid && latest.pid !== latestExecutionPid) {
                return { ...latest, pid: latestExecutionPid };
            }
            return latest;
        }
        const latestStartingActivity = Math.max(Number(latest.startedAt || 0), Number(latest.updatedAt || 0));
        if (latest.status === 'starting' && now - latestStartingActivity < STARTING_STATUS_GRACE_MS) {
            return latest;
        }
        const finalState = safeReadJson(statePath) as DetachedRunState | undefined;
        if (finalState && TERMINAL_STATUSES.has(finalState.status)) return finalState;
        const orphaned = finalState || latest;
        return {
            ...orphaned,
            orphanedStatus: orphaned.status,
            status: 'failure',
            errorCode: 'RUN_WORKER_NOT_RUNNING',
            error: 'Detached worker is not running.',
            endedAt: now,
            updatedAt: now
        };
    }

    list_run_statuses(): DetachedRunState[] {
        return this.list_runs()
            .map((state) => this.getRunStatus(state.detachedRunId) || state)
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    private resultFromState(state: DetachedRunState, reused: boolean, recovered?: boolean): StartDetachedResult {
        return {
            run_id: state.detachedRunId,
            detached_run_id: state.detachedRunId,
            ...(state.correlationId ? { correlation_id: state.correlationId } : {}),
            ...(state.pid ? { pid: state.pid } : {}),
            status: state.correlationId ? state.status : 'detached',
            reused,
            ...(recovered ? { recovered: true } : {})
        };
    }

    start_detached(options: StartDetachedOptions): StartDetachedResult {
        const pipeline = String(options.pipeline || '').trim();
        if (!pipeline) throw new RunSupervisorError('PIPELINE_REQUIRED', 'start_detached requires pipeline.');
        const pipelinePath = canonicalExistingPath(
            resolvePipelinePath(this.workspaceRoot, pipeline),
            'PIPELINE_NOT_FOUND',
            'Pipeline'
        );
        const pipelineHash = createHash('sha256').update(fs.readFileSync(pipelinePath)).digest('hex');
        const from = String(options.from || '').trim() || undefined;
        const dryRun = options.dryRun === true;
        const fingerprint = requestFingerprint({
            workspaceRoot: this.workspaceRoot,
            pipelinePath,
            pipelineHash,
            from,
            dryRun
        });
        const correlationId = options.correlationId === undefined
            ? undefined
            : validateCorrelationId(options.correlationId);
        const correlation = correlationId ? this.claimCorrelation(correlationId, fingerprint) : undefined;
        const detachedRunId = correlation?.claim.detachedRunId || this.newRunId();
        const statePath = stateFilePath(this.workspaceRoot, detachedRunId);
        let state = safeReadJson(statePath) as DetachedRunState | undefined;
        let recovered = false;

        if (state) {
            if (state.requestFingerprint && state.requestFingerprint !== fingerprint) {
                throw new RunSupervisorError('RUN_CORRELATION_CONFLICT', 'Detached run state does not match immutable run parameters.');
            }
            if ((state.correlationId || undefined) !== correlationId) {
                throw new RunSupervisorError('RUN_CORRELATION_CONFLICT', 'Detached run state has a different correlation_id.');
            }
        } else {
            const now = this.now();
            const proposed: DetachedRunState = {
                detachedRunId,
                ...(correlationId ? { correlationId } : {}),
                requestFingerprint: fingerprint,
                workspaceRoot: this.workspaceRoot,
                pipeline,
                pipelinePath,
                pipelineHash,
                from,
                dryRun,
                status: 'starting',
                startedAt: now,
                updatedAt: now,
                checkpointEveryNodes: this.checkpointEveryNodes()
            };
            if (!writeExclusiveJson(statePath, proposed)) {
                const concurrentState = readClaimWithRetry(statePath) as DetachedRunState | undefined;
                if (!concurrentState?.detachedRunId) {
                    throw new RunSupervisorError('RUN_STATE_INVALID', 'Detached run state is unreadable.');
                }
                state = concurrentState;
            } else {
                state = proposed;
                appendEventRecord(eventsFilePath(this.workspaceRoot, detachedRunId), {
                    eventVersion: 1,
                    ts: now,
                    runId: detachedRunId,
                    type: 'run.detached_started',
                    payload: {
                        detachedRunId,
                        correlationId,
                        pipeline,
                        pipelinePath,
                        from,
                        dryRun,
                        checkpointEveryNodes: proposed.checkpointEveryNodes
                    }
                });
            }
        }

        const persistedState = state;
        const reconciledState = this.getRunStatus(detachedRunId) || state;
        if (!persistedState.pid && reconciledState.pid && correlation && !correlation.created) {
            recovered = true;
        }
        const recoverableStarting = (
            reconciledState.status === 'failure'
            && reconciledState.errorCode === 'RUN_WORKER_NOT_RUNNING'
            && reconciledState.orphanedStatus === 'starting'
        );
        if (!recoverableStarting) {
            state = reconciledState;
            if (TERMINAL_STATUSES.has(state.status) || (state.pid && this.isProcessAlive(state.pid))) {
                return this.resultFromState(state, Boolean(correlation && !correlation.created), recovered);
            }
            if (state.status !== 'starting') {
                return this.resultFromState(state, Boolean(correlation && !correlation.created));
            }
        } else {
            state = persistedState;
        }
        const executionPid = this.activeExecutionPid(detachedRunId);
        if (executionPid) {
            return this.resultFromState({ ...state, pid: executionPid }, true, true);
        }
        recovered = Boolean(correlation && !correlation.created);
        if (!this.acquireSpawnClaim(detachedRunId)) {
            const current = this.getRunStatus(detachedRunId) || safeReadJson(statePath) as DetachedRunState | undefined;
            return this.resultFromState(current || state, true);
        }

        const spawnClaimPath = spawnClaimFilePath(this.workspaceRoot, detachedRunId);
        try {
            let current = (safeReadJson(statePath) || state) as DetachedRunState;
            if (TERMINAL_STATUSES.has(current.status)) {
                return this.resultFromState(current, Boolean(correlation && !correlation.created));
            }
            let activeExecutionPid = this.activeExecutionPid(detachedRunId);
            if (activeExecutionPid) {
                return this.resultFromState({ ...current, pid: activeExecutionPid }, true, true);
            }
            if (current.pid && this.isProcessAlive(current.pid)) {
                return this.resultFromState(current, true);
            }

            // A worker writes its terminal state before exiting and releases its
            // execution claim on process teardown. Re-read only after liveness
            // checks so a completion racing this retry wins before any respawn.
            current = (safeReadJson(statePath) || current) as DetachedRunState;
            if (TERMINAL_STATUSES.has(current.status)) {
                return this.resultFromState(current, Boolean(correlation && !correlation.created));
            }
            activeExecutionPid = this.activeExecutionPid(detachedRunId);
            if (activeExecutionPid) {
                return this.resultFromState({ ...current, pid: activeExecutionPid }, true, true);
            }
            if (current.pid && this.isProcessAlive(current.pid)) {
                return this.resultFromState(current, true);
            }
            if (current.status !== 'starting') {
                return this.resultFromState(
                    this.getRunStatus(detachedRunId) || current,
                    Boolean(correlation && !correlation.created)
                );
            }
            const workerEntry = path.resolve(__dirname, 'runSupervisorWorker.js');
            const args = [
                workerEntry,
                '--workspace', this.workspaceRoot,
                '--run_id', detachedRunId,
                '--pipeline', pipeline,
                '--pipeline_path', pipelinePath,
                '--pipeline_hash', pipelineHash
            ];
            if (from) args.push('--from', from);
            if (dryRun) args.push('--dry_run');
            if (options.verbose) args.push('--verbose');
            const child = this.spawnProcess(process.execPath, args, {
                cwd: this.workspaceRoot,
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            state = { ...current, pid: child.pid, updatedAt: this.now(), error: undefined };
            try {
                this.persistState(statePath, state);
            } catch {
                throw new RunSupervisorError(
                    'RUN_STATE_PERSIST_FAILED',
                    'Detached run pid could not be persisted.'
                );
            }
            return this.resultFromState(state, Boolean(correlation && !correlation.created), recovered);
        } catch (error: any) {
            if (error instanceof RunSupervisorError) throw error;
            throw new RunSupervisorError('RUN_WORKER_SPAWN_FAILED', 'Detached worker could not be spawned.');
        } finally {
            try { fs.unlinkSync(spawnClaimPath); } catch { /* noop */ }
        }
    }

    tail_events(runId: string, cursor?: number): { events: RunEventRecord[]; nextCursor: number } {
        const state = this.findRunState(runId);
        if (!state) throw new RunSupervisorError('RUN_NOT_FOUND', `Run not found for id: ${runId}`);
        const filePath = eventsFilePath(this.workspaceRoot, state.detachedRunId);
        if (!fs.existsSync(filePath)) return { events: [], nextCursor: 0 };
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        const from = Math.max(0, Math.floor(Number(cursor || 0)));
        const parsed: RunEventRecord[] = [];
        for (let index = from; index < lines.length; index += 1) {
            try {
                const row = JSON.parse(lines[index]);
                if (row && row.eventVersion === 1) parsed.push(row as RunEventRecord);
            } catch { /* ignore malformed lines */ }
        }
        const config = safeReadJson(path.join(this.workspaceRoot, '.intent-router', 'config.json'));
        const maxItems = normalizePositiveInt(
            config?.intentRouter?.tui?.events?.maxItems ?? config?.['intentRouter.tui.events.maxItems'],
            5000
        );
        return {
            events: parsed.length > maxItems ? parsed.slice(parsed.length - maxItems) : parsed,
            nextCursor: lines.length
        };
    }
}
