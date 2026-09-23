import * as vscode from './ports/vscodeShim';
import {
    STEP_LIFECYCLE_EVENT_TYPE,
    STEP_LIFECYCLE_EVENT_VERSION,
    StepLifecycleEvent,
    StepLifecycleMachine,
    StepLifecycleState,
    isTerminalStepLifecycleState,
    runtimeLogicalExecutionId
} from './stepLifecycleContract';

export type PipelineEvent =
    | { type: 'pipelineStart'; runId: string; timestamp: number; totalSteps?: number; name?: string; pipeline?: any }
    | { type: 'pipelineEnd'; runId: string; timestamp: number; success: boolean; status?: 'success' | 'failure' | 'cancelled' }
    | { type: 'stepStart'; runId: string; intentId: string; timestamp: number; description?: string; intent?: string; index?: number; stepId?: string; logicalExecutionId?: string; attempt?: number }
    | { type: 'stepEnd'; runId: string; intentId: string; timestamp: number; success: boolean; index?: number; stepId?: string; logicalExecutionId?: string; attempt?: number; lifecycleState?: 'succeeded' | 'failed' | 'cancelled' | 'skipped' }
    | StepLifecycleEvent
    | { type: 'stepLog'; runId: string; intentId: string; stepId?: string; text: string; stream: 'stdout' | 'stderr' }
    | {
        type: 'approvalReviewReady';
        runId: string;
        intentId: string;
        stepId?: string;
        files: Array<{ path: string; added: number; removed: number }>;
        totalAdded: number;
        totalRemoved: number;
        diffSignature?: string;
        policyMode?: 'warn' | 'block';
        policyBlocked?: boolean;
        policyViolations?: string[];
    }
    | {
        type: 'teamRunSummary';
        runId: string;
        intentId: string;
        stepId?: string;
        strategy: 'sequential' | 'reviewer_gate' | 'vote';
        winnerMember?: string;
        winnerReason?: string;
        voteScoreByMember?: Array<{ member: string; role: 'writer' | 'reviewer'; weight: number; score: number }>;
        members: Array<{ name: string; role: 'writer' | 'reviewer'; path: string; files: number }>;
        totalFiles: number;
    }
    | {
        type: 'githubPullRequestCreated';
        runId?: string;
        intentId?: string;
        stepId?: string;
        provider: 'github';
        url: string;
        number?: number;
        state?: 'open' | 'closed' | 'merged';
        isDraft?: boolean;
        head: string;
        base: string;
        title: string;
    }
    | {
        type: 'jules.session_created' | 'jules.session_observed';
        runId?: string;
        intentId?: string;
        stepId?: string;
        sessionId: string;
        state: string;
        sessionUrl?: string;
    }
    | {
        type: 'jules.plan_approved';
        runId?: string;
        intentId?: string;
        stepId?: string;
        sessionId: string;
        approved: true;
    }
    | {
        type: 'jules.pull_request_observed';
        runId?: string;
        intentId?: string;
        stepId?: string;
        sessionId: string;
        pullRequestUrl: string;
        pullRequestOwner: string;
        pullRequestRepository: string;
        pullRequestNumber: number;
    }
    | {
        type: 'jules.request_failed';
        runId?: string;
        intentId?: string;
        stepId?: string;
        operation: 'sources.list' | 'session.create' | 'session.get' | 'plan.approve' | 'activities.list';
        code: string;
        sessionId?: string;
    }
    | { type: 'pipelineDecision'; nodeId?: string; runId?: string; approvedPaths?: string[]; decision: 'approve' | 'reject' }
    | { type: 'pipelineReviewOpenDiff'; nodeId?: string; runId?: string; path?: string }
    | { type: 'pipelinePause'; runId: string; timestamp: number }
    | { type: 'pipelineResume'; runId: string; timestamp: number };

type Listener = (event: PipelineEvent) => void;

class EventBus {
    private static readonly CLOSED_RUN_RETENTION = 1024;
    private listeners: Listener[] = [];
    private readonly lifecycle = new StepLifecycleMachine();
    private readonly lifecycleIdsByRun = new Map<string, Set<string>>();
    private readonly openRuns = new Set<string>();
    // Pipeline-end cleanup removes every per-step position. Retained run tombstones
    // block late events and are evicted in deterministic insertion order.
    private readonly closedRuns = new Map<string, true>();
    private readonly activeLifecycle = new Map<string, {
        runId: string;
        intentId?: string;
        stepId?: string;
        index?: number;
        attempt: number;
    }>();

    on(listener: Listener): vscode.Disposable {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            }
        };
    }

    private dispatch(event: PipelineEvent): void {
        this.listeners.forEach(l => l(event));
    }

    private lifecycleIdentity(event: {
        runId: string;
        intentId?: string;
        stepId?: string | null;
        index?: number;
        logicalExecutionId?: string;
    }): string {
        const explicit = String(event.logicalExecutionId || '').trim();
        if (explicit) return runtimeLogicalExecutionId(event.runId, 'explicit', explicit);
        return runtimeLogicalExecutionId(
            event.runId,
            'derived',
            event.intentId || '',
            event.stepId || '',
            Number.isSafeInteger(event.index) ? event.index : ''
        );
    }

    emitStepLifecycle(input: {
        runId: string;
        intentId?: string;
        stepId?: string | null;
        index?: number;
        logicalExecutionId?: string;
        attempt: number;
        state: StepLifecycleState;
        timestamp?: number;
    }): boolean {
        const event: StepLifecycleEvent = {
            type: STEP_LIFECYCLE_EVENT_TYPE,
            eventType: STEP_LIFECYCLE_EVENT_TYPE,
            eventVersion: STEP_LIFECYCLE_EVENT_VERSION,
            runId: input.runId,
            ...(input.intentId ? { intentId: input.intentId } : {}),
            logicalExecutionId: this.lifecycleIdentity(input),
            attempt: input.attempt,
            stepId: String(input.stepId || '').trim() || null,
            sourceNodeId: null,
            state: input.state,
            timestamp: Number.isFinite(input.timestamp) ? Math.floor(Number(input.timestamp)) : Date.now(),
            ...(Number.isSafeInteger(input.index) ? { index: input.index } : {})
        };
        return this.emitQualifiedStepLifecycle(event);
    }

    private emitQualifiedStepLifecycle(event: StepLifecycleEvent): boolean {
        if (!this.openRuns.has(event.runId) || this.closedRuns.has(event.runId)) return false;
        if (!this.lifecycle.accept(event)) return false;
        const runLifecycleIds = this.lifecycleIdsByRun.get(event.runId) || new Set<string>();
        runLifecycleIds.add(event.logicalExecutionId);
        this.lifecycleIdsByRun.set(event.runId, runLifecycleIds);
        if (isTerminalStepLifecycleState(event.state)) {
            this.activeLifecycle.delete(event.logicalExecutionId);
        } else {
            this.activeLifecycle.set(event.logicalExecutionId, {
                runId: event.runId,
                ...(event.intentId ? { intentId: event.intentId } : {}),
                ...(event.stepId ? { stepId: event.stepId } : {}),
                ...(Number.isSafeInteger(event.index) ? { index: event.index } : {}),
                attempt: event.attempt
            });
        }
        this.dispatch(event);
        return true;
    }

    emit(event: PipelineEvent): void {
        if (event.type === 'pipelineStart') {
            if (!this.closedRuns.has(event.runId)) this.openRuns.add(event.runId);
            this.dispatch(event);
            return;
        }
        if (event.type === 'stepStart') {
            if (!this.openRuns.has(event.runId) || this.closedRuns.has(event.runId)) {
                this.dispatch(event);
                return;
            }
            this.emitStepLifecycle({
                runId: event.runId,
                intentId: event.intentId,
                stepId: event.stepId,
                index: event.index,
                logicalExecutionId: event.logicalExecutionId,
                attempt: Number.isSafeInteger(event.attempt) && Number(event.attempt) > 0 ? Number(event.attempt) : 1,
                state: 'running',
                timestamp: event.timestamp
            });
            this.dispatch(event);
            return;
        }
        if (event.type === 'stepEnd') {
            if (!this.openRuns.has(event.runId) || this.closedRuns.has(event.runId)) {
                this.dispatch(event);
                return;
            }
            const logicalExecutionId = this.lifecycleIdentity(event);
            const position = this.lifecycle.position(logicalExecutionId);
            const attempt = Number.isSafeInteger(event.attempt) && Number(event.attempt) > 0
                ? Number(event.attempt)
                : (position?.attempt || 1);
            if (!position) {
                this.emitQualifiedStepLifecycle({
                    type: STEP_LIFECYCLE_EVENT_TYPE,
                    eventType: STEP_LIFECYCLE_EVENT_TYPE,
                    eventVersion: STEP_LIFECYCLE_EVENT_VERSION,
                    runId: event.runId,
                    intentId: event.intentId,
                    stepId: String(event.stepId || '').trim() || null,
                    sourceNodeId: null,
                    ...(Number.isSafeInteger(event.index) ? { index: event.index } : {}),
                    logicalExecutionId,
                    attempt,
                    state: 'unknown',
                    timestamp: event.timestamp
                });
                this.dispatch(event);
                return;
            }
            const state = event.lifecycleState || (event.success ? 'succeeded' : 'failed');
            this.emitQualifiedStepLifecycle({
                type: STEP_LIFECYCLE_EVENT_TYPE,
                eventType: STEP_LIFECYCLE_EVENT_TYPE,
                eventVersion: STEP_LIFECYCLE_EVENT_VERSION,
                runId: event.runId,
                intentId: event.intentId,
                stepId: String(event.stepId || '').trim() || null,
                sourceNodeId: null,
                ...(Number.isSafeInteger(event.index) ? { index: event.index } : {}),
                logicalExecutionId,
                attempt,
                state,
                timestamp: event.timestamp
            });
            this.dispatch(event);
            return;
        }
        if (event.type === STEP_LIFECYCLE_EVENT_TYPE) {
            this.emitStepLifecycle(event);
            return;
        }
        if (event.type === 'pipelineEnd') {
            const incomplete = [...this.activeLifecycle.entries()]
                .filter(([, position]) => position.runId === event.runId);
            for (const [logicalExecutionId, position] of incomplete) {
                this.emitQualifiedStepLifecycle({
                    type: STEP_LIFECYCLE_EVENT_TYPE,
                    eventType: STEP_LIFECYCLE_EVENT_TYPE,
                    eventVersion: STEP_LIFECYCLE_EVENT_VERSION,
                    ...position,
                    logicalExecutionId,
                    stepId: position.stepId || null,
                    sourceNodeId: null,
                    state: 'unknown',
                    timestamp: event.timestamp
                });
            }
            const lifecycleIds = this.lifecycleIdsByRun.get(event.runId);
            for (const logicalExecutionId of lifecycleIds || []) {
                this.lifecycle.delete(logicalExecutionId);
                this.activeLifecycle.delete(logicalExecutionId);
            }
            this.lifecycleIdsByRun.delete(event.runId);
            this.openRuns.delete(event.runId);
            this.closedRuns.set(event.runId, true);
            while (this.closedRuns.size > EventBus.CLOSED_RUN_RETENTION) {
                const oldest = this.closedRuns.keys().next().value as string | undefined;
                if (!oldest) break;
                this.closedRuns.delete(oldest);
            }
        }
        this.dispatch(event);
    }
}

export const pipelineEventBus = new EventBus();
