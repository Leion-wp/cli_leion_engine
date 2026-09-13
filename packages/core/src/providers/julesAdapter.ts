import { julesCapabilities } from '../builtinCapabilities';
import * as vscode from '../ports/vscodeShim';
import { registerCapabilities } from '../registry';
import { pipelineEventBus } from '../eventBus';

export const JULES_API_BASE_URL = 'https://jules.googleapis.com/v1alpha';
export const JULES_MAX_RESPONSE_BYTES = 512 * 1024;
export const JULES_DEFAULT_TIMEOUT_MS = 30_000;
export const JULES_MAX_PAGE_SIZE = 100;

export type JulesProviderErrorCode =
    | 'JULES_NOT_CONFIGURED'
    | 'JULES_REQUEST_INVALID'
    | 'JULES_PLAN_APPROVAL_REQUIRED'
    | 'JULES_AUTH_FAILED'
    | 'JULES_NOT_FOUND'
    | 'JULES_RATE_LIMITED'
    | 'JULES_INVALID_STATE'
    | 'JULES_UNAVAILABLE'
    | 'JULES_UPSTREAM_ERROR'
    | 'JULES_RESPONSE_INVALID'
    | 'JULES_RESPONSE_TOO_LARGE'
    | 'JULES_TIMEOUT';

export class JulesProviderError extends Error {
    readonly code: JulesProviderErrorCode;

    constructor(code: JulesProviderErrorCode, message: string) {
        super(message);
        this.name = 'JulesProviderError';
        this.code = code;
    }
}

type FetchResponse = {
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    body?: {
        getReader?: () => {
            read: () => Promise<{ done: boolean; value?: Uint8Array }>;
            cancel?: () => Promise<void>;
        };
        cancel?: () => Promise<void>;
    } | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
};

type FetchLike = (url: string, init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'error';
}) => Promise<FetchResponse>;

export type JulesClientOptions = {
    // Dependency injection is intentionally available only at this factory
    // boundary for deterministic tests. Pipeline payloads cannot set these.
    apiKey?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    maxResponseBytes?: number;
};

export type JulesSession = {
    name: string;
    id: string;
    state: string;
    url?: string;
    createTime?: string;
    updateTime?: string;
    outputs: Array<{
        pullRequest: {
            url: string;
            owner: string;
            repository: string;
            number: number;
        };
    }>;
};

export type JulesClient = {
    listSources(args?: any): Promise<any>;
    createSession(args: any): Promise<JulesSession>;
    getSession(args: any): Promise<JulesSession>;
    approvePlan(args: any): Promise<{ sessionId: string; approved: true }>;
    listActivities(args: any): Promise<any>;
};

const SESSION_STATES = new Set([
    'STATE_UNSPECIFIED',
    'QUEUED',
    'PLANNING',
    'AWAITING_PLAN_APPROVAL',
    'AWAITING_USER_FEEDBACK',
    'IN_PROGRESS',
    'PAUSED',
    'FAILED',
    'COMPLETED'
]);

const ACTIVITY_TYPES: Array<[string, string]> = [
    ['planGenerated', 'plan_generated'],
    ['planApproved', 'plan_approved'],
    ['userMessaged', 'user_messaged'],
    ['agentMessaged', 'agent_messaged'],
    ['progressUpdated', 'progress_updated'],
    ['sessionCompleted', 'session_completed'],
    ['sessionFailed', 'session_failed']
];

function utf8Length(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function normalizeArgs(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
    if (value === undefined || value === null) return Object.create(null);
    if (typeof value !== 'object' || Array.isArray(value)) throw staticError('JULES_REQUEST_INVALID');
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw staticError('JULES_REQUEST_INVALID');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const output: Record<string, unknown> = Object.create(null);
        const allowed = new Set([...allowedKeys, '__meta']);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== 'string') throw staticError('JULES_REQUEST_INVALID');
            const descriptor = descriptors[key];
            if (descriptor.get || descriptor.set) throw staticError('JULES_REQUEST_INVALID');
            if (!descriptor.enumerable) continue;
            if (!allowed.has(key)) throw staticError('JULES_REQUEST_INVALID');
            output[key] = descriptor.value;
        }
        return output;
    } catch (error) {
        if (error instanceof JulesProviderError) throw error;
        throw staticError('JULES_REQUEST_INVALID');
    }
}

function staticError(code: JulesProviderErrorCode): JulesProviderError {
    const messages: Record<JulesProviderErrorCode, string> = {
        JULES_NOT_CONFIGURED: 'Jules is not configured.',
        JULES_REQUEST_INVALID: 'The Jules request is invalid.',
        JULES_PLAN_APPROVAL_REQUIRED: 'Jules sessions require explicit plan approval.',
        JULES_AUTH_FAILED: 'Jules authentication failed.',
        JULES_NOT_FOUND: 'The Jules resource was not found.',
        JULES_RATE_LIMITED: 'Jules rate limited the request.',
        JULES_INVALID_STATE: 'The Jules resource is not in a valid state for this operation.',
        JULES_UNAVAILABLE: 'Jules is unavailable.',
        JULES_UPSTREAM_ERROR: 'Jules rejected the request.',
        JULES_RESPONSE_INVALID: 'Jules returned an invalid response.',
        JULES_RESPONSE_TOO_LARGE: 'Jules returned a response larger than the allowed limit.',
        JULES_TIMEOUT: 'The Jules request timed out.'
    };
    return new JulesProviderError(code, messages[code]);
}

function readApiKey(value: unknown): string {
    const raw = typeof value === 'string' ? value : '';
    const key = raw.trim();
    if (!key || utf8Length(key) > 4096 || /[\x00-\x1f\x7f]/.test(raw)) {
        throw staticError('JULES_NOT_CONFIGURED');
    }
    return key;
}

export function isJulesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        readApiKey(env.JULES_API_KEY);
        return true;
    } catch {
        return false;
    }
}

function requiredMultilineString(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string') throw staticError('JULES_REQUEST_INVALID');
    const normalized = value.trim();
    if (!normalized || utf8Length(normalized) > maxBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
        throw staticError('JULES_REQUEST_INVALID');
    }
    return normalized;
}

function requiredSingleLineString(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw staticError('JULES_REQUEST_INVALID');
    const normalized = requiredMultilineString(value, maxBytes);
    return normalized;
}

function optionalSingleLineString(value: unknown, maxBytes: number): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return requiredSingleLineString(value, maxBytes);
}

function boundedResponseString(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string' || !value || utf8Length(value) > maxBytes || /[\x00-\x1f\x7f]/.test(value)) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    return value;
}

function optionalResponseString(value: unknown, maxBytes: number): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return boundedResponseString(value, maxBytes);
}

function normalizeSessionId(value: unknown): string {
    const raw = requiredSingleLineString(value, 264);
    const id = raw.startsWith('sessions/') ? raw.slice('sessions/'.length) : raw;
    if (!/^[A-Za-z0-9._~-]{1,255}$/.test(id)) throw staticError('JULES_REQUEST_INVALID');
    return id;
}

function normalizeSource(value: unknown): string {
    const source = requiredSingleLineString(value, 1024);
    if (!/^sources\/[A-Za-z0-9._~/-]+$/.test(source) || source.endsWith('/') || source.includes('..') || source.includes('//')) {
        throw staticError('JULES_REQUEST_INVALID');
    }
    return source;
}

function normalizeGitBranch(value: unknown): string {
    const branch = requiredSingleLineString(value, 512);
    const components = branch.split('/');
    if (
        /\s/.test(branch) ||
        branch === '@' ||
        branch.startsWith('-') ||
        branch.startsWith('/') ||
        branch.endsWith('/') ||
        branch.startsWith('.') ||
        branch.endsWith('.') ||
        branch.includes('..') ||
        branch.includes('//') ||
        branch.includes('@{') ||
        /[~^:?*[\]\\]/.test(branch) ||
        components.some((component) => component.startsWith('.') || component.endsWith('.') || component.toLowerCase().endsWith('.lock'))
    ) {
        throw staticError('JULES_REQUEST_INVALID');
    }
    return branch;
}

function normalizePageSize(value: unknown, defaultValue: number): number {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value !== 'number' && typeof value !== 'string') throw staticError('JULES_REQUEST_INVALID');
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw staticError('JULES_REQUEST_INVALID');
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > JULES_MAX_PAGE_SIZE) {
        throw staticError('JULES_REQUEST_INVALID');
    }
    return numberValue;
}

function safeTimestamp(value: unknown): string | undefined {
    const text = optionalResponseString(value, 64);
    if (text === undefined) return undefined;
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}|\d{9}))?Z$/);
    if (!match) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    const date = new Date(text);
    if (
        Number(match[1]) === 0 ||
        !Number.isFinite(date.getTime()) ||
        date.getUTCFullYear() !== Number(match[1]) ||
        date.getUTCMonth() + 1 !== Number(match[2]) ||
        date.getUTCDate() !== Number(match[3]) ||
        date.getUTCHours() !== Number(match[4]) ||
        date.getUTCMinutes() !== Number(match[5]) ||
        date.getUTCSeconds() !== Number(match[6])
    ) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    return date.toISOString();
}

function safeJulesUrl(value: unknown, sessionId: string): string | undefined {
    const text = optionalResponseString(value, 2048);
    if (!text) return undefined;
    try {
        const parsed = new URL(text);
        if (
            parsed.protocol !== 'https:' ||
            parsed.hostname.toLowerCase() !== 'jules.google.com' ||
            parsed.port ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            parsed.pathname !== `/session/${sessionId}`
        ) throw new Error('unsafe');
        return parsed.toString();
    } catch {
        throw staticError('JULES_RESPONSE_INVALID');
    }
}

function parsePullRequest(value: unknown): JulesSession['outputs'][number] {
    const raw = value as any;
    const text = boundedResponseString(raw?.url, 2048);
    try {
        const parsed = new URL(text);
        const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]{1,256})\/([A-Za-z0-9_.-]{1,256})\/pull\/([1-9]\d*)$/);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match) {
            throw new Error('invalid');
        }
        const number = Number(match[3]);
        const owner = match[1];
        const repository = match[2];
        if (!Number.isSafeInteger(number) || number <= 0 || match[3] !== String(number)) {
            throw new Error('identity');
        }
        return {
            pullRequest: {
                url: parsed.toString(),
                owner,
                repository,
                number
            }
        };
    } catch {
        throw staticError('JULES_RESPONSE_INVALID');
    }
}

function projectSession(value: unknown): JulesSession {
    const raw = value as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw staticError('JULES_RESPONSE_INVALID');
    const id = boundedResponseString(raw.id, 255);
    if (!/^[A-Za-z0-9._~-]{1,255}$/.test(id)) throw staticError('JULES_RESPONSE_INVALID');
    const name = boundedResponseString(raw.name, 1024);
    if (name !== `sessions/${id}`) throw staticError('JULES_RESPONSE_INVALID');
    const state = boundedResponseString(raw.state, 64);
    if (!SESSION_STATES.has(state)) throw staticError('JULES_RESPONSE_INVALID');
    const outputsRaw = raw.outputs === undefined ? [] : raw.outputs;
    if (!Array.isArray(outputsRaw) || outputsRaw.length > 20) throw staticError('JULES_RESPONSE_INVALID');
    const outputs = outputsRaw.map((entry: any) => {
        if (!entry || typeof entry !== 'object' || !entry.pullRequest) throw staticError('JULES_RESPONSE_INVALID');
        return parsePullRequest(entry.pullRequest);
    });
    const url = safeJulesUrl(raw.url, id);
    const createTime = safeTimestamp(raw.createTime);
    const updateTime = safeTimestamp(raw.updateTime);
    return {
        name,
        id,
        state,
        ...(url ? { url } : {}),
        ...(createTime ? { createTime } : {}),
        ...(updateTime ? { updateTime } : {}),
        outputs
    };
}

function projectSource(value: unknown): any {
    const raw = value as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw staticError('JULES_RESPONSE_INVALID');
    const id = boundedResponseString(raw.id, 512);
    const name = boundedResponseString(raw.name, 1024);
    if (!/^[A-Za-z0-9._~/-]{1,512}$/.test(id) || id.startsWith('/') || id.endsWith('/') || id.includes('..') || id.includes('//') || name !== `sources/${id}`) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    const repo = raw.githubRepo;
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) throw staticError('JULES_RESPONSE_INVALID');
    const owner = boundedResponseString(repo.owner, 256);
    const repository = boundedResponseString(repo.repo, 256);
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository) || (repo.isPrivate !== undefined && typeof repo.isPrivate !== 'boolean')) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    return { name, id, githubRepo: { owner, repository, isPrivate: repo.isPrivate === true } };
}

function projectActivity(value: unknown, sessionId: string): any {
    const raw = value as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw staticError('JULES_RESPONSE_INVALID');
    const id = boundedResponseString(raw.id, 512);
    const name = boundedResponseString(raw.name, 1024);
    if (!/^[A-Za-z0-9._~-]{1,512}$/.test(id) || name !== `sessions/${sessionId}/activities/${id}`) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    const originator = optionalResponseString(raw.originator, 64);
    if (originator !== undefined && !['user', 'agent', 'system'].includes(originator)) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    const createTime = safeTimestamp(raw.createTime);
    const present = ACTIVITY_TYPES.filter(([field]) => raw[field] !== undefined);
    if (present.length !== 1 || !raw[present[0][0]] || typeof raw[present[0][0]] !== 'object' || Array.isArray(raw[present[0][0]])) {
        throw staticError('JULES_RESPONSE_INVALID');
    }
    return {
        name,
        id,
        type: present[0][1],
        ...(originator ? { originator } : {}),
        ...(createTime ? { createTime } : {})
    };
}

async function cancelBody(response: FetchResponse): Promise<void> {
    try {
        await response.body?.cancel?.();
    } catch {
        // Response cleanup is best effort and never changes the stable error.
    }
}

function errorForStatus(status: number): JulesProviderError {
    if (status === 400 || status === 422) return staticError('JULES_REQUEST_INVALID');
    if (status === 401 || status === 403) return staticError('JULES_AUTH_FAILED');
    if (status === 404) return staticError('JULES_NOT_FOUND');
    if (status === 409 || status === 412) return staticError('JULES_INVALID_STATE');
    if (status === 429) return staticError('JULES_RATE_LIMITED');
    if (status === 502 || status === 503 || status === 504) return staticError('JULES_UNAVAILABLE');
    return staticError('JULES_UPSTREAM_ERROR');
}

async function readBoundedJson(response: FetchResponse, maxBytes: number, allowEmpty = false): Promise<any> {
    const declaredLength = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await cancelBody(response);
        throw staticError('JULES_RESPONSE_TOO_LARGE');
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    const reader = response.body?.getReader?.();
    if (reader) {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            const chunk = Buffer.from(item.value || new Uint8Array());
            bytes += chunk.length;
            if (bytes > maxBytes) {
                try { await reader.cancel?.(); } catch { /* best effort */ }
                throw staticError('JULES_RESPONSE_TOO_LARGE');
            }
            chunks.push(chunk);
        }
    } else if (response.arrayBuffer) {
        const raw = Buffer.from(await response.arrayBuffer());
        if (raw.length > maxBytes) throw staticError('JULES_RESPONSE_TOO_LARGE');
        chunks.push(raw);
    } else {
        throw staticError('JULES_RESPONSE_INVALID');
    }

    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!text.trim() && allowEmpty) return {};
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
        return parsed;
    } catch {
        throw staticError('JULES_RESPONSE_INVALID');
    }
}

export function createJulesClient(options: JulesClientOptions = {}): JulesClient {
    const apiKey = readApiKey(options.apiKey === undefined ? process.env.JULES_API_KEY : options.apiKey);
    const fetchImpl = options.fetchImpl || ((globalThis as any).fetch as FetchLike | undefined);
    if (typeof fetchImpl !== 'function') throw staticError('JULES_UNAVAILABLE');
    const timeoutMs = options.timeoutMs === undefined ? JULES_DEFAULT_TIMEOUT_MS : options.timeoutMs;
    const maxResponseBytes = options.maxResponseBytes === undefined ? JULES_MAX_RESPONSE_BYTES : options.maxResponseBytes;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > JULES_MAX_RESPONSE_BYTES) {
        throw staticError('JULES_REQUEST_INVALID');
    }

    const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: Record<string, unknown>,
        allowEmpty = false
    ): Promise<any> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${JULES_API_BASE_URL}${path}`, {
                method,
                headers: {
                    'accept': 'application/json',
                    'x-goog-api-key': apiKey,
                    ...(body ? { 'content-type': 'application/json' } : {})
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
                redirect: 'error'
            });
            if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
                throw staticError('JULES_RESPONSE_INVALID');
            }
            if (!response.ok) {
                await cancelBody(response);
                throw errorForStatus(response.status);
            }
            return await readBoundedJson(response, maxResponseBytes, allowEmpty);
        } catch (error: any) {
            if (error instanceof JulesProviderError) throw error;
            if (controller.signal.aborted) throw staticError('JULES_TIMEOUT');
            throw staticError('JULES_UNAVAILABLE');
        } finally {
            clearTimeout(timeout);
        }
    };

    return {
        async listSources(args: any = {}): Promise<any> {
            const input = normalizeArgs(args, ['pageSize', 'pageToken']);
            const pageSize = normalizePageSize(input.pageSize, 30);
            const pageToken = optionalSingleLineString(input.pageToken, 4096);
            const query = new URLSearchParams({ pageSize: String(pageSize) });
            if (pageToken) query.set('pageToken', pageToken);
            const raw = await request('GET', `/sources?${query.toString()}`);
            const sources = raw.sources === undefined ? [] : raw.sources;
            if (!Array.isArray(sources) || sources.length > JULES_MAX_PAGE_SIZE) throw staticError('JULES_RESPONSE_INVALID');
            const nextPageToken = optionalResponseString(raw.nextPageToken, 4096);
            return {
                sources: sources.map(projectSource),
                ...(nextPageToken ? { nextPageToken } : {})
            };
        },

        async createSession(args: any): Promise<JulesSession> {
            const input = normalizeArgs(args, ['prompt', 'title', 'source', 'startingBranch', 'requirePlanApproval', 'autoCreatePr']);
            const prompt = requiredMultilineString(input.prompt, 65_536);
            const title = optionalSingleLineString(input.title, 512);
            if (input.requirePlanApproval === false) throw staticError('JULES_PLAN_APPROVAL_REQUIRED');
            if (input.requirePlanApproval !== undefined && typeof input.requirePlanApproval !== 'boolean') throw staticError('JULES_REQUEST_INVALID');
            if (input.autoCreatePr !== undefined && typeof input.autoCreatePr !== 'boolean') throw staticError('JULES_REQUEST_INVALID');
            const hasSource = input.source !== undefined && input.source !== null && input.source !== '';
            const hasBranch = input.startingBranch !== undefined && input.startingBranch !== null && input.startingBranch !== '';
            if (hasSource !== hasBranch) throw staticError('JULES_REQUEST_INVALID');
            if (input.autoCreatePr === true && !hasSource) throw staticError('JULES_REQUEST_INVALID');
            const body: Record<string, unknown> = { prompt, requirePlanApproval: true };
            if (title) body.title = title;
            if (hasSource) {
                body.sourceContext = {
                    source: normalizeSource(input.source),
                    githubRepoContext: { startingBranch: normalizeGitBranch(input.startingBranch) }
                };
            }
            if (input.autoCreatePr === true) body.automationMode = 'AUTO_CREATE_PR';
            return projectSession(await request('POST', '/sessions', body));
        },

        async getSession(args: any): Promise<JulesSession> {
            const input = normalizeArgs(args, ['sessionId']);
            const id = normalizeSessionId(input.sessionId);
            return projectSession(await request('GET', `/sessions/${encodeURIComponent(id)}`));
        },

        async approvePlan(args: any): Promise<{ sessionId: string; approved: true }> {
            const input = normalizeArgs(args, ['sessionId']);
            const id = normalizeSessionId(input.sessionId);
            await request('POST', `/sessions/${encodeURIComponent(id)}:approvePlan`, {}, true);
            return { sessionId: id, approved: true };
        },

        async listActivities(args: any): Promise<any> {
            const input = normalizeArgs(args, ['sessionId', 'pageSize', 'pageToken']);
            const id = normalizeSessionId(input.sessionId);
            const pageSize = normalizePageSize(input.pageSize, 50);
            const pageToken = optionalSingleLineString(input.pageToken, 4096);
            const query = new URLSearchParams({ pageSize: String(pageSize) });
            if (pageToken) query.set('pageToken', pageToken);
            const raw = await request('GET', `/sessions/${encodeURIComponent(id)}/activities?${query.toString()}`);
            const activities = raw.activities === undefined ? [] : raw.activities;
            if (!Array.isArray(activities) || activities.length > JULES_MAX_PAGE_SIZE) throw staticError('JULES_RESPONSE_INVALID');
            const nextPageToken = optionalResponseString(raw.nextPageToken, 4096);
            return {
                sessionId: id,
                activities: activities.map((entry: unknown) => projectActivity(entry, id)),
                ...(nextPageToken ? { nextPageToken } : {})
            };
        }
    };
}

function defaultClient(): JulesClient {
    return createJulesClient();
}

function eventMeta(rawArgs: unknown): { runId?: string; intentId?: string; stepId?: string } {
    try {
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return {};
        const metaDescriptor = Object.getOwnPropertyDescriptor(rawArgs, '__meta');
        if (!metaDescriptor || metaDescriptor.get || metaDescriptor.set || !metaDescriptor.value || typeof metaDescriptor.value !== 'object') return {};
        const meta = metaDescriptor.value;
        const prototype = Object.getPrototypeOf(meta);
        if (prototype !== Object.prototype && prototype !== null) return {};
        const descriptors = Object.getOwnPropertyDescriptors(meta);
        const safe = (key: string): string | undefined => {
            const descriptor = descriptors[key];
            if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'string') return undefined;
            const value = descriptor.value.trim();
            return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : undefined;
        };
        return { runId: safe('runId'), intentId: safe('traceId'), stepId: safe('stepId') };
    } catch {
        return {};
    }
}

function validatedSessionIdFromArgs(rawArgs: unknown): string | undefined {
    try {
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return undefined;
        const prototype = Object.getPrototypeOf(rawArgs);
        if (prototype !== Object.prototype && prototype !== null) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(rawArgs, 'sessionId');
        if (!descriptor || descriptor.get || descriptor.set) return undefined;
        return normalizeSessionId(descriptor.value);
    } catch {
        return undefined;
    }
}

function emitSessionEvents(type: 'jules.session_created' | 'jules.session_observed', args: unknown, session: JulesSession): void {
    const meta = eventMeta(args);
    pipelineEventBus.emit({
        type,
        ...meta,
        sessionId: session.id,
        state: session.state,
        ...(session.url ? { sessionUrl: session.url } : {})
    });
    for (const output of session.outputs) {
        pipelineEventBus.emit({
            type: 'jules.pull_request_observed',
            ...meta,
            sessionId: session.id,
            pullRequestUrl: output.pullRequest.url,
            pullRequestOwner: output.pullRequest.owner,
            pullRequestRepository: output.pullRequest.repository,
            pullRequestNumber: output.pullRequest.number
        });
    }
}

async function executeSessionCreate(args: any): Promise<JulesSession> {
    const session = await defaultClient().createSession(args);
    emitSessionEvents('jules.session_created', args, session);
    return session;
}

async function executeSessionGet(args: any): Promise<JulesSession> {
    const session = await defaultClient().getSession(args);
    emitSessionEvents('jules.session_observed', args, session);
    return session;
}

async function approvePlanWithHumanGate(args: any): Promise<{ sessionId: string; approved: true }> {
    const input = normalizeArgs(args, ['sessionId']);
    const id = normalizeSessionId(input.sessionId);
    const selection = await vscode.window.showWarningMessage(
        `Approve the Jules plan for session ${id}?`,
        { modal: true },
        'Approve plan',
        'Cancel'
    );
    if (selection !== 'Approve plan') throw staticError('JULES_PLAN_APPROVAL_REQUIRED');
    const result = await defaultClient().approvePlan({ sessionId: id });
    pipelineEventBus.emit({ type: 'jules.plan_approved', ...eventMeta(args), sessionId: id, approved: true });
    return result;
}

export function registerJulesProvider(context: vscode.ExtensionContext): boolean {
    if (!isJulesConfigured()) return false;
    registerCapabilities(julesCapabilities);
    const execute = async <T>(
        operation: 'sources.list' | 'session.create' | 'session.get' | 'plan.approve' | 'activities.list',
        args: any,
        invoke: () => Promise<T>
    ): Promise<T> => {
        try {
            return await invoke();
        } catch (error: any) {
            if (error instanceof JulesProviderError) {
                const sessionId = validatedSessionIdFromArgs(args);
                pipelineEventBus.emit({
                    type: 'jules.request_failed',
                    ...eventMeta(args),
                    operation,
                    code: error.code,
                    ...(sessionId ? { sessionId } : {})
                });
            }
            throw error;
        }
    };
    const registrations = [
        vscode.commands.registerCommand('intentRouter.internal.julesSourcesList', async (args: any) => await execute('sources.list', args, async () => await defaultClient().listSources(args))),
        vscode.commands.registerCommand('intentRouter.internal.julesSessionCreate', async (args: any) => await execute('session.create', args, async () => await executeSessionCreate(args))),
        vscode.commands.registerCommand('intentRouter.internal.julesSessionGet', async (args: any) => await execute('session.get', args, async () => await executeSessionGet(args))),
        vscode.commands.registerCommand('intentRouter.internal.julesPlanApprove', async (args: any) => await execute('plan.approve', args, async () => await approvePlanWithHumanGate(args))),
        vscode.commands.registerCommand('intentRouter.internal.julesActivitiesList', async (args: any) => await execute('activities.list', args, async () => await defaultClient().listActivities(args)))
    ];
    context.subscriptions.push(...registrations);
    return true;
}
