import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
    RUN_LOG_CURSOR_FORMAT,
    RUN_LOG_DEFAULT_LIMIT,
    RUN_LOG_EVENT_VERSION,
    RUN_LOG_MAX_LIMIT,
    RUN_LOG_MAX_RECORD_BYTES,
    RUN_LOG_MAX_RESPONSE_BYTES,
    RUN_LOG_MAX_SCAN_BYTES
} from '../runLogContract';

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
    lastControlRequestId?: string;
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

export type RunLogEvent = RunEventRecord & {
    event_id: string;
    occurred_at: string | null;
    event_version: 1;
    sequence: number;
    run_id: string;
    detached_run_id: string;
    correlation_id?: string;
    step_id?: string;
    source_node_id?: string;
};

export type RunLogPage = {
    run_id: string;
    detached_run_id: string;
    correlation_id?: string;
    events: RunLogEvent[];
    next_cursor: string;
    has_more: boolean;
    nextCursor: number;
    hasMore: boolean;
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

export function cancelFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${validateRunId(detachedRunId)}.cancel.json`);
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

function replaceJsonAtomically(temporaryPath: string, filePath: string): void {
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(temporaryPath, filePath);
            return;
        } catch (error: any) {
            const transientWindowsLock = process.platform === 'win32' &&
                ['EACCES', 'EBUSY', 'EPERM'].includes(String(error?.code || ''));
            if (!transientWindowsLock || attempt >= 99) throw error;
            sleepSync(10);
        }
    }
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
        replaceJsonAtomically(temporaryPath, filePath);
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

const JULES_ERROR_CODES = new Set([
    'JULES_NOT_CONFIGURED', 'JULES_REQUEST_INVALID', 'JULES_PLAN_APPROVAL_REQUIRED',
    'JULES_AUTH_FAILED', 'JULES_NOT_FOUND', 'JULES_RATE_LIMITED',
    'JULES_INVALID_STATE', 'JULES_UNAVAILABLE', 'JULES_UPSTREAM_ERROR',
    'JULES_RESPONSE_INVALID', 'JULES_RESPONSE_TOO_LARGE', 'JULES_TIMEOUT'
]);

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
    if (eventType.startsWith('jules.')) {
        const safe: Record<string, any> = {};
        for (const key of ['runId', 'intentId', 'stepId'] as const) {
            if (typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value[key])) safe[key] = value[key];
        }
        const sessionId = typeof value.sessionId === 'string' && /^[A-Za-z0-9._~-]{1,255}$/.test(value.sessionId)
            ? value.sessionId
            : undefined;
        if (sessionId) safe.sessionId = sessionId;
        if (eventType === 'jules.session_created' || eventType === 'jules.session_observed') {
            if (typeof value.state === 'string' && [
                'STATE_UNSPECIFIED', 'QUEUED', 'PLANNING', 'AWAITING_PLAN_APPROVAL',
                'AWAITING_USER_FEEDBACK', 'IN_PROGRESS', 'PAUSED', 'FAILED', 'COMPLETED'
            ].includes(value.state)) safe.state = value.state;
            if (sessionId && typeof value.sessionUrl === 'string' && Buffer.byteLength(value.sessionUrl, 'utf8') <= 2048) {
                try {
                    const url = new URL(value.sessionUrl);
                    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.hostname.toLowerCase() === 'jules.google.com' && url.pathname === `/session/${sessionId}`) {
                        safe.sessionUrl = url.toString();
                    }
                } catch { /* omit invalid URL */ }
            }
        } else if (eventType === 'jules.plan_approved') {
            if (value.approved === true) safe.approved = true;
        } else if (eventType === 'jules.pull_request_observed') {
            const owner = typeof value.pullRequestOwner === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value.pullRequestOwner) ? value.pullRequestOwner : undefined;
            const repository = typeof value.pullRequestRepository === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value.pullRequestRepository) ? value.pullRequestRepository : undefined;
            const number = Number.isSafeInteger(value.pullRequestNumber) && value.pullRequestNumber > 0 ? value.pullRequestNumber : undefined;
            if (owner) safe.pullRequestOwner = owner;
            if (repository) safe.pullRequestRepository = repository;
            if (number) safe.pullRequestNumber = number;
            if (owner && repository && number && typeof value.pullRequestUrl === 'string' && Buffer.byteLength(value.pullRequestUrl, 'utf8') <= 2048) {
                try {
                    const url = new URL(value.pullRequestUrl);
                    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.hostname.toLowerCase() === 'github.com' && url.pathname === `/${owner}/${repository}/pull/${number}`) {
                        safe.pullRequestUrl = url.toString();
                    }
                } catch { /* omit invalid URL */ }
            }
        } else if (eventType === 'jules.request_failed') {
            if (typeof value.operation === 'string' && [
                'sources.list', 'session.create', 'session.get', 'plan.approve', 'activities.list'
            ].includes(value.operation)) safe.operation = value.operation;
            if (typeof value.code === 'string' && JULES_ERROR_CODES.has(value.code)) safe.code = value.code;
        }
        return safe;
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

type RunLogCursorPosition = {
    sequence: number;
    byteOffset?: number;
    legacy: boolean;
};

const LOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const LOG_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function cursorChecksum(detachedRunId: string, sequence: number, byteOffset: number): string {
    return createHash('sha256')
        .update(`${detachedRunId}\0${sequence}\0${byteOffset}`, 'utf8')
        .digest('hex')
        .slice(0, 16);
}

function encodeRunLogCursor(detachedRunId: string, sequence: number, byteOffset: number): string {
    return `${RUN_LOG_CURSOR_FORMAT}.${sequence}.${byteOffset}.${cursorChecksum(detachedRunId, sequence, byteOffset)}`;
}

function parseRunLogCursor(detachedRunId: string, cursor?: string | number): RunLogCursorPosition {
    if (cursor === undefined || cursor === null || cursor === '') {
        return { sequence: 0, byteOffset: 0, legacy: false };
    }
    const raw = String(cursor).trim();
    if (/^[0-9]+$/.test(raw)) {
        const sequence = Number(raw);
        if (Number.isSafeInteger(sequence)) return { sequence, legacy: true };
    }
    const match = new RegExp(`^${RUN_LOG_CURSOR_FORMAT}\\.([0-9]+)\\.([0-9]+)\\.([a-f0-9]{16})$`).exec(raw);
    if (match) {
        const sequence = Number(match[1]);
        const byteOffset = Number(match[2]);
        if (
            Number.isSafeInteger(sequence)
            && Number.isSafeInteger(byteOffset)
            && match[3] === cursorChecksum(detachedRunId, sequence, byteOffset)
        ) {
            return { sequence, byteOffset, legacy: false };
        }
    }
    throw new RunSupervisorError('RUN_CURSOR_INVALID', 'run_logs cursor is invalid for this run.');
}

function normalizeRunLogLimit(limit?: number): number {
    if (limit === undefined) return RUN_LOG_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUN_LOG_MAX_LIMIT) {
        throw new RunSupervisorError(
            'RUN_LIMIT_INVALID',
            `run_logs limit must be an integer between 1 and ${RUN_LOG_MAX_LIMIT}.`
        );
    }
    return limit;
}

function locateLegacyCursorOffset(
    descriptor: number,
    snapshotSize: number,
    targetSequence: number
): number {
    if (targetSequence === 0) return 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let sequence = 0;
    while (position < snapshotSize && position < RUN_LOG_MAX_SCAN_BYTES) {
        const length = Math.min(chunk.length, snapshotSize - position, RUN_LOG_MAX_SCAN_BYTES - position);
        const bytesRead = fs.readSync(descriptor, chunk, 0, length, position);
        if (bytesRead <= 0) break;
        for (let index = 0; index < bytesRead; index += 1) {
            if (chunk[index] !== 0x0a) continue;
            sequence += 1;
            if (sequence === targetSequence) return position + index + 1;
        }
        position += bytesRead;
    }
    if (position >= RUN_LOG_MAX_SCAN_BYTES && position < snapshotSize) {
        throw new RunSupervisorError('RUN_LOG_SCAN_LIMIT', 'Legacy run_logs cursor exceeds the bounded scan window.');
    }
    throw new RunSupervisorError('RUN_CURSOR_INVALID', 'run_logs cursor is beyond the persisted event stream.');
}

function safeLogPayload(eventType: string, value: any): Record<string, any> {
    const projected = projectRunEventPayload(eventType, value);
    const safe: Record<string, any> = {};
    const idFields = new Set(['runId', 'intentId', 'nodeId', 'stepId', 'detachedRunId', 'correlationId']);
    const numberFields = new Set([
        'index', 'timestamp', 'totalSteps', 'completedSteps', 'checkpointEveryNodes', 'textLength',
        'pullRequestNumber'
    ]);
    const booleanFields = new Set(['success', 'dryRun', 'approved']);
    const enumFields: Record<string, Set<string>> = {
        stream: new Set(['stdout', 'stderr']),
        action: new Set(['pause', 'resume', 'cancel']),
        status: new Set(['starting', 'running', 'pause_requested', 'paused', 'cancel_requested', 'success', 'failure', 'cancelled', 'detached'])
    };
    const julesStates = new Set([
        'STATE_UNSPECIFIED', 'QUEUED', 'PLANNING', 'AWAITING_PLAN_APPROVAL',
        'AWAITING_USER_FEEDBACK', 'IN_PROGRESS', 'PAUSED', 'FAILED', 'COMPLETED'
    ]);
    const julesOperations = new Set(['sources.list', 'session.create', 'session.get', 'plan.approve', 'activities.list']);
    for (const [key, entry] of Object.entries(projected)) {
        if (numberFields.has(key)) {
            if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) safe[key] = entry;
            continue;
        }
        if (booleanFields.has(key)) {
            if (typeof entry === 'boolean') safe[key] = entry;
            continue;
        }
        if (typeof entry !== 'string') continue;
        if (idFields.has(key)) {
            if (LOG_ID_PATTERN.test(entry)) safe[key] = entry;
            continue;
        }
        if (enumFields[key]) {
            if (enumFields[key].has(entry)) safe[key] = entry;
            continue;
        }
        if (key === 'code') {
            if (LOG_CODE_PATTERN.test(entry) && (eventType !== 'jules.request_failed' || JULES_ERROR_CODES.has(entry))) safe[key] = entry;
            continue;
        }
        if (key === 'textSha256' && /^[a-f0-9]{64}$/.test(entry)) safe[key] = entry;
        if (key === 'sessionId' && /^[A-Za-z0-9._~-]{1,255}$/.test(entry)) safe[key] = entry;
        if ((key === 'pullRequestOwner' || key === 'pullRequestRepository') && /^[A-Za-z0-9_.-]{1,256}$/.test(entry)) safe[key] = entry;
        if (key === 'state' && julesStates.has(entry)) safe[key] = entry;
        if (key === 'operation' && julesOperations.has(entry)) safe[key] = entry;
        if (key === 'sessionUrl') {
            try {
                const url = new URL(entry);
                if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.hostname.toLowerCase() === 'jules.google.com' && /^\/session\/[A-Za-z0-9._~-]+$/.test(url.pathname)) safe[key] = url.toString();
            } catch { /* omit invalid URL */ }
        }
        if (key === 'pullRequestUrl') {
            try {
                const url = new URL(entry);
                if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.hostname.toLowerCase() === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url.pathname)) safe[key] = url.toString();
            } catch { /* omit invalid URL */ }
        }
    }
    return safe;
}

function stableRunLogEventId(detachedRunId: string, byteOffset: number): string {
    return `evt_${createHash('sha256').update(`${detachedRunId}\0${byteOffset}`, 'utf8').digest('hex')}`;
}

function projectPersistedRunLogEvent(
    detachedRunId: string,
    correlationId: string | undefined,
    sequence: number,
    byteOffset: number,
    line: Buffer
): RunLogEvent {
    const eventId = stableRunLogEventId(detachedRunId, byteOffset);
    const corrupt = (type: 'run.record_corrupt' | 'run.record_oversize', code: string): RunLogEvent => ({
        eventVersion: RUN_LOG_EVENT_VERSION,
        ts: 0,
        runId: detachedRunId,
        type,
        payload: { code },
        event_id: eventId,
        occurred_at: null,
        event_version: RUN_LOG_EVENT_VERSION,
        sequence,
        run_id: detachedRunId,
        detached_run_id: detachedRunId,
        ...(correlationId ? { correlation_id: correlationId } : {})
    });
    if (line.byteLength > RUN_LOG_MAX_RECORD_BYTES) {
        return corrupt('run.record_oversize', 'RUN_LOG_RECORD_OVERSIZE');
    }
    let parsed: any;
    try {
        const text = line.length > 0 && line[line.length - 1] === 0x0d
            ? line.subarray(0, line.length - 1).toString('utf8')
            : line.toString('utf8');
        parsed = JSON.parse(text);
    } catch {
        return corrupt('run.record_corrupt', 'RUN_LOG_RECORD_CORRUPT');
    }
    const rawType = String(parsed?.type || '').trim();
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || parsed.eventVersion !== RUN_LOG_EVENT_VERSION
        || !LOG_ID_PATTERN.test(rawType)
    ) {
        return corrupt('run.record_corrupt', 'RUN_LOG_RECORD_CORRUPT');
    }
    const timestamp = Number(parsed.ts);
    const validTimestamp = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000;
    const safeTimestamp = validTimestamp ? Math.floor(timestamp) : 0;
    const payload = safeLogPayload(rawType, parsed.payload);
    const persistedRunId = String(parsed.runId || '').trim();
    const safeRunId = LOG_ID_PATTERN.test(persistedRunId) ? persistedRunId : detachedRunId;
    return {
        eventVersion: RUN_LOG_EVENT_VERSION,
        ts: safeTimestamp,
        runId: safeRunId,
        type: rawType,
        payload,
        event_id: eventId,
        occurred_at: validTimestamp ? new Date(safeTimestamp).toISOString() : null,
        event_version: RUN_LOG_EVENT_VERSION,
        sequence,
        run_id: safeRunId,
        detached_run_id: detachedRunId,
        ...(correlationId ? { correlation_id: correlationId } : {}),
        ...(typeof payload.stepId === 'string' ? { step_id: payload.stepId } : {}),
        ...(typeof payload.nodeId === 'string' ? { source_node_id: payload.nodeId } : {})
    };
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
        const response = () => ({
            run_id: requestedRunId,
            detached_run_id: detachedRunId,
            ...(state.correlationId ? { correlation_id: state.correlationId } : {}),
            action
        });
        const cancellationPath = cancelFilePath(this.workspaceRoot, detachedRunId);
        const cancellationIsDurable = fs.existsSync(cancellationPath)
            || persistedState.cancelRequested === true
            || persistedState.status === 'cancel_requested';
        if (cancellationIsDurable) {
            if (action === 'cancel') return response();
            throw new RunSupervisorError(
                'RUN_CONTROL_INVALID_STATE',
                `Cannot ${action} a detached run after cancellation was requested.`
            );
        }
        const pendingControl = safeReadJson(ctrlFilePath(this.workspaceRoot, detachedRunId));
        if (action === 'pause' && (persistedState.status === 'pause_requested' || persistedState.status === 'paused')) {
            return response();
        }
        if (action === 'resume') {
            if (String(pendingControl?.action || '').trim() === 'resume') return response();
            if (
                (persistedState.status === 'starting' || persistedState.status === 'running')
                && String(pendingControl?.action || '').trim() !== 'pause'
            ) {
                return response();
            }
        }
        const updatedAt = this.now();
        const controlPath = ctrlFilePath(this.workspaceRoot, detachedRunId);
        const requestId = randomBytes(12).toString('hex');
        const control = { action, requestedRunId, requestId, updatedAt };
        if (action === 'cancel') {
            // Cancellation has its own write-once marker. A concurrent pause or
            // resume may replace the latest-control file, but it cannot erase
            // this marker, so cancellation always wins when the worker polls.
            writeExclusiveJson(cancellationPath, control);
        }
        writeJsonFile(controlPath, control);
        const latest = safeReadJson(statePath) as DetachedRunState | undefined;
        if (latest && TERMINAL_STATUSES.has(latest.status)) {
            try { fs.unlinkSync(controlPath); } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error;
            }
            if (action === 'cancel') {
                try { fs.unlinkSync(cancellationPath); } catch (error: any) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
            throw new RunSupervisorError(
                'RUN_CONTROL_INVALID_STATE',
                `Cannot ${action} a terminal detached run.`
            );
        }
        return response();
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

    tail_events(runId: string, cursor?: string | number, limit?: number): RunLogPage {
        const state = this.findRunState(runId);
        if (!state) throw new RunSupervisorError('RUN_NOT_FOUND', `Run not found for id: ${runId}`);
        const pageLimit = normalizeRunLogLimit(limit);
        const cursorPosition = parseRunLogCursor(state.detachedRunId, cursor);
        const filePath = eventsFilePath(this.workspaceRoot, state.detachedRunId);
        const requestedRunId = String(runId || '').trim();
        const buildPage = (
            events: RunLogEvent[],
            sequence: number,
            byteOffset: number,
            hasMore: boolean
        ): RunLogPage => ({
            run_id: requestedRunId,
            detached_run_id: state.detachedRunId,
            ...(state.correlationId ? { correlation_id: state.correlationId } : {}),
            events,
            next_cursor: encodeRunLogCursor(state.detachedRunId, sequence, byteOffset),
            has_more: hasMore,
            nextCursor: sequence,
            hasMore
        });
        const emptyPage = (sequence: number, byteOffset: number): RunLogPage => (
            buildPage([], sequence, byteOffset, false)
        );
        if (!fs.existsSync(filePath)) {
            if (cursorPosition.sequence !== 0 || Number(cursorPosition.byteOffset || 0) !== 0) {
                throw new RunSupervisorError('RUN_CURSOR_INVALID', 'run_logs cursor is beyond the persisted event stream.');
            }
            return emptyPage(0, 0);
        }
        const descriptor = fs.openSync(filePath, 'r');
        try {
            const snapshotSize = fs.fstatSync(descriptor).size;
            const startOffset = cursorPosition.legacy
                ? locateLegacyCursorOffset(descriptor, snapshotSize, cursorPosition.sequence)
                : Number(cursorPosition.byteOffset || 0);
            if (startOffset < 0 || startOffset > snapshotSize) {
                throw new RunSupervisorError('RUN_CURSOR_INVALID', 'run_logs cursor is beyond the persisted event stream.');
            }
            if (startOffset > 0) {
                const boundary = Buffer.allocUnsafe(1);
                const boundaryRead = fs.readSync(descriptor, boundary, 0, 1, startOffset - 1);
                if (boundaryRead !== 1 || boundary[0] !== 0x0a) {
                    throw new RunSupervisorError('RUN_CURSOR_INVALID', 'run_logs cursor does not point to a record boundary.');
                }
            }
            if (startOffset === snapshotSize) return emptyPage(cursorPosition.sequence, startOffset);

            const readLength = Math.min(snapshotSize - startOffset, RUN_LOG_MAX_SCAN_BYTES);
            const buffer = Buffer.allocUnsafe(readLength);
            let bytesRead = 0;
            while (bytesRead < readLength) {
                const count = fs.readSync(
                    descriptor,
                    buffer,
                    bytesRead,
                    readLength - bytesRead,
                    startOffset + bytesRead
                );
                if (count <= 0) break;
                bytesRead += count;
            }
            const snapshot = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
            const events: RunLogEvent[] = [];
            let lineStart = 0;
            let nextSequence = cursorPosition.sequence;
            let nextOffset = startOffset;
            let hasMore = false;

            for (let index = 0; index < snapshot.length; index += 1) {
                if (snapshot[index] !== 0x0a) continue;
                if (events.length >= pageLimit) {
                    hasMore = true;
                    break;
                }
                const event = projectPersistedRunLogEvent(
                    state.detachedRunId,
                    state.correlationId,
                    nextSequence,
                    startOffset + lineStart,
                    snapshot.subarray(lineStart, index)
                );
                const candidateSequence = nextSequence + 1;
                const candidateOffset = startOffset + index + 1;
                const candidatePage = buildPage(
                    [...events, event],
                    candidateSequence,
                    candidateOffset,
                    true
                );
                const candidateBytes = Buffer.byteLength(`${JSON.stringify(candidatePage, null, 2)}\n`, 'utf8');
                if (events.length > 0 && candidateBytes > RUN_LOG_MAX_RESPONSE_BYTES) {
                    hasMore = true;
                    break;
                }
                events.push(event);
                nextSequence = candidateSequence;
                nextOffset = candidateOffset;
                lineStart = index + 1;
            }

            if (!hasMore && nextOffset < snapshotSize && snapshotSize > startOffset + snapshot.length) {
                if (lineStart < snapshot.length) {
                    throw new RunSupervisorError('RUN_LOG_SCAN_LIMIT', 'A run log record exceeds the bounded scan window.');
                }
                hasMore = true;
            }
            return buildPage(events, nextSequence, nextOffset, hasMore);
        } finally {
            fs.closeSync(descriptor);
        }
    }
}
