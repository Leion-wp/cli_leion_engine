import { createHash } from 'crypto';

export const STEP_LIFECYCLE_EVENT_TYPE = 'step_lifecycle' as const;
export const STEP_LIFECYCLE_EVENT_VERSION = 1 as const;

export const STEP_LIFECYCLE_STATES = Object.freeze([
    'running',
    'retrying',
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
    'unknown'
] as const);

export type StepLifecycleState = typeof STEP_LIFECYCLE_STATES[number];

export const STEP_LIFECYCLE_TERMINAL_STATES = Object.freeze([
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
    'unknown'
] as const);

export const STEP_LIFECYCLE_TRANSITIONS = Object.freeze({
    unknown: Object.freeze([] as const),
    running: Object.freeze(['retrying', 'succeeded', 'failed', 'cancelled', 'skipped', 'unknown'] as const),
    retrying: Object.freeze(['running', 'failed', 'cancelled', 'unknown'] as const),
    succeeded: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
    skipped: Object.freeze([] as const)
});

export const STEP_LIFECYCLE_CONTRACT = Object.freeze({
    version: '1',
    eventType: STEP_LIFECYCLE_EVENT_TYPE,
    eventVersion: STEP_LIFECYCLE_EVENT_VERSION,
    states: STEP_LIFECYCLE_STATES,
    terminalStates: STEP_LIFECYCLE_TERMINAL_STATES,
    transitions: STEP_LIFECYCLE_TRANSITIONS,
    compatibilityEvents: Object.freeze({ start: 'stepStart', end: 'stepEnd' }),
    runtimeRunId: Object.freeze({
        uniqueness: 'required',
        generator: 'time_plus_secure_random',
        reuse: 'invalid'
    }),
    scope: Object.freeze({
        opensOn: 'pipelineStart',
        closesOn: 'pipelineEnd',
        duplicatePipelineStart: 'rejected_without_dispatch',
        lifecycleOutsideOpenRun: 'rejected',
        legacyCompatibilityOutsideOpenRun: 'dispatched'
    }),
    closedRunRetention: Object.freeze({
        strategy: 'fifo',
        max: 1024,
        duplicatePipelineStart: 'rejected_without_dispatch_while_retained'
    }),
    persistence: Object.freeze({
        canonicalLifecycle: 'required',
        auxiliaryEvents: 'best_effort'
    }),
    terminalTransitions: 'forbidden',
    retryAttempt: 'increment_on_running',
    incompleteTransition: 'unknown',
    missingAttribution: 'null',
    identityFields: Object.freeze([
        'runtime_run_id',
        'detached_run_id',
        'logical_execution_id',
        'attempt',
        'step_id',
        'source_node_id'
    ]),
    provenanceFields: Object.freeze(['pipeline_hash', 'pipeline_path', 'plan_id']),
    timestampFields: Object.freeze(['origin_timestamp', 'persisted_timestamp']),
    cursor: Object.freeze({ contract: 'run_logs', replay: 'stable_event_id_and_sequence' })
});

export type StepLifecycleEvent = {
    type: typeof STEP_LIFECYCLE_EVENT_TYPE;
    eventType: typeof STEP_LIFECYCLE_EVENT_TYPE;
    eventVersion: typeof STEP_LIFECYCLE_EVENT_VERSION;
    runId: string;
    intentId?: string;
    logicalExecutionId: string;
    attempt: number;
    stepId: string | null;
    sourceNodeId: string | null;
    state: StepLifecycleState;
    timestamp: number;
    index?: number;
};

export type DurableStepLifecyclePayload = {
    eventType: typeof STEP_LIFECYCLE_EVENT_TYPE;
    eventVersion: typeof STEP_LIFECYCLE_EVENT_VERSION;
    runtimeRunId: string;
    detachedRunId: string;
    logicalExecutionId: string;
    attempt: number;
    stepId: string | null;
    sourceNodeId: string | null;
    pipelineHash: string | null;
    pipelinePath: string | null;
    planId: string | null;
    state: StepLifecycleState;
    originTimestamp: number | null;
    persistedTimestamp: number;
};

const TERMINAL = new Set<StepLifecycleState>(STEP_LIFECYCLE_TERMINAL_STATES);
const STATE = new Set<StepLifecycleState>(STEP_LIFECYCLE_STATES);

export function isStepLifecycleState(value: unknown): value is StepLifecycleState {
    return typeof value === 'string' && STATE.has(value as StepLifecycleState);
}

export function isTerminalStepLifecycleState(value: StepLifecycleState): boolean {
    return TERMINAL.has(value);
}

export function stableLogicalExecutionId(...parts: Array<string | number | null | undefined>): string {
    const canonical = parts.map((part) => part === null || part === undefined ? '' : String(part)).join('\0');
    return `step_${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function runtimeLogicalExecutionId(
    runtimeRunId: string,
    ...logicalParts: Array<string | number | null | undefined>
): string {
    return stableLogicalExecutionId(runtimeRunId, ...logicalParts);
}

export function stepLifecycleTransitionAllowed(
    previous: StepLifecycleState | undefined,
    next: StepLifecycleState
): boolean {
    if (!previous) return next === 'running' || next === 'cancelled' || next === 'skipped' || next === 'unknown';
    if (isTerminalStepLifecycleState(previous)) return false;
    if (previous === 'running') return STEP_LIFECYCLE_TRANSITIONS.running.includes(next as any);
    return STEP_LIFECYCLE_TRANSITIONS.retrying.includes(next as any);
}

type LifecyclePosition = { state: StepLifecycleState; attempt: number };

/** Process-local transition guard. Durable replay remains authoritative in run_logs. */
export class StepLifecycleMachine {
    private readonly positions = new Map<string, LifecyclePosition>();

    accept(event: Pick<StepLifecycleEvent, 'logicalExecutionId' | 'attempt' | 'state'>): boolean {
        const logicalExecutionId = String(event.logicalExecutionId || '').trim();
        if (!logicalExecutionId || !Number.isSafeInteger(event.attempt) || event.attempt <= 0 || !isStepLifecycleState(event.state)) {
            return false;
        }
        const previous = this.positions.get(logicalExecutionId);
        if (!stepLifecycleTransitionAllowed(previous?.state, event.state)) return false;
        if (previous) {
            const expectedAttempt = previous.state === 'retrying' && event.state === 'running'
                ? previous.attempt + 1
                : previous.attempt;
            if (event.attempt !== expectedAttempt) return false;
        }
        this.positions.set(logicalExecutionId, { state: event.state, attempt: event.attempt });
        return true;
    }

    position(logicalExecutionId: string): LifecyclePosition | undefined {
        const position = this.positions.get(logicalExecutionId);
        return position ? { ...position } : undefined;
    }

    delete(logicalExecutionId: string): void {
        this.positions.delete(logicalExecutionId);
    }
}
