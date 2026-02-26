import * as fs from 'fs';
import * as path from 'path';
import { CoreRuntime } from '../coreRuntime';
import { Disposable } from '../ports/vscodeShim';

export type PendingApproval = {
    id: string;
    runId: string;
    nodeId: string;
    stepId?: string;
    intentId?: string;
    prompt?: string;
    decision?: 'approve' | 'reject';
    approvedPaths?: string[];
    status: 'pending' | 'resolved' | 'acked';
    createdAt: number;
    updatedAt: number;
    source: 'approval.request' | 'approvalReviewReady';
    review?: {
        files: Array<{ path: string; added: number; removed: number }>;
        totalAdded: number;
        totalRemoved: number;
        diffSignature?: string;
        policyMode?: 'warn' | 'block';
        policyBlocked?: boolean;
        policyViolations?: string[];
    };
};

function safeReadJson(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

export class ApprovalInboxService {
    private readonly filePath: string;
    private listener?: Disposable;

    constructor(private readonly runtime: CoreRuntime, subscribeToRuntimeEvents = true) {
        const workspaceRoot = runtime.get_workspace_root();
        this.filePath = path.join(workspaceRoot, '.intent-router', 'approvals.json');
        if (subscribeToRuntimeEvents) {
            this.listener = runtime.on_event((event: any) => {
                this.consumeRuntimeEvent(event);
            });
        }
    }

    dispose(): void {
        try {
            this.listener?.dispose();
        } catch {
            // noop
        }
    }

    list_pending(): PendingApproval[] {
        return this.readAll().filter((entry) => entry.status === 'pending');
    }

    list_all(): PendingApproval[] {
        return this.readAll();
    }

    resolve(input: {
        pendingId?: string;
        nodeId?: string;
        runId?: string;
        decision: 'approve' | 'reject';
        approvedPaths?: string[];
    }): PendingApproval {
        const rows = this.readAll();
        const now = Date.now();
        const normalizedPendingId = String(input.pendingId || '').trim();
        const normalizedNodeId = String(input.nodeId || '').trim();
        const normalizedRunId = String(input.runId || '').trim();

        const row = rows.find((entry) => {
            if (normalizedPendingId && entry.id === normalizedPendingId) return true;
            if (normalizedNodeId && normalizedRunId) {
                return entry.nodeId === normalizedNodeId && entry.runId === normalizedRunId;
            }
            return false;
        });
        if (!row) {
            throw new Error('Pending approval not found.');
        }
        row.status = 'resolved';
        row.decision = input.decision;
        row.approvedPaths = Array.isArray(input.approvedPaths) ? input.approvedPaths : undefined;
        row.updatedAt = now;
        this.writeAll(rows);
        this.runtime.resolve_decision(row.nodeId, input.decision, row.runId, row.approvedPaths);
        return row;
    }

    ack(pendingId: string): PendingApproval {
        const normalized = String(pendingId || '').trim();
        if (!normalized) {
            throw new Error('pendingId is required.');
        }
        const rows = this.readAll();
        const row = rows.find((entry) => entry.id === normalized);
        if (!row) {
            throw new Error(`Pending approval not found: ${normalized}`);
        }
        row.status = 'acked';
        row.updatedAt = Date.now();
        this.writeAll(rows);
        return row;
    }

    private consumeRuntimeEvent(event: any): void {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'approval.request') {
            this.insertOrUpdateFromRequest(event);
            return;
        }
        if (event.type === 'approvalReviewReady') {
            this.insertOrUpdateFromReview(event);
            return;
        }
        if (event.type === 'pipelineDecision') {
            this.markResolvedByDecision(event);
        }
    }

    private approvalId(runId: string, nodeId: string): string {
        return `${runId}:${nodeId}`;
    }

    private insertOrUpdateFromRequest(event: any): void {
        const runId = String(event?.runId || '').trim();
        const nodeId = String(event?.nodeId || event?.stepId || '').trim();
        if (!runId || !nodeId) return;
        const rows = this.readAll();
        const id = this.approvalId(runId, nodeId);
        const now = Date.now();
        const existing = rows.find((entry) => entry.id === id);
        if (existing) {
            existing.prompt = String(event?.prompt || '').trim() || existing.prompt;
            existing.updatedAt = now;
            this.writeAll(rows);
            return;
        }
        rows.unshift({
            id,
            runId,
            nodeId,
            stepId: String(event?.stepId || '').trim() || undefined,
            intentId: String(event?.intentId || '').trim() || undefined,
            prompt: String(event?.prompt || '').trim() || undefined,
            status: 'pending',
            createdAt: Number(event?.createdAt || now),
            updatedAt: now,
            source: 'approval.request'
        });
        this.writeAll(rows);
    }

    private insertOrUpdateFromReview(event: any): void {
        const runId = String(event?.runId || '').trim();
        const nodeId = String(event?.stepId || '').trim();
        if (!runId || !nodeId) return;
        const rows = this.readAll();
        const id = this.approvalId(runId, nodeId);
        const now = Date.now();
        const rawPolicyMode = String(event?.policyMode || '').trim().toLowerCase();
        const policyMode: 'warn' | 'block' | undefined = rawPolicyMode === 'warn' || rawPolicyMode === 'block'
            ? rawPolicyMode
            : undefined;
        const review = {
            files: Array.isArray(event?.files) ? event.files : [],
            totalAdded: Number(event?.totalAdded || 0),
            totalRemoved: Number(event?.totalRemoved || 0),
            diffSignature: String(event?.diffSignature || '').trim() || undefined,
            policyMode,
            policyBlocked: event?.policyBlocked === true,
            policyViolations: Array.isArray(event?.policyViolations) ? event.policyViolations : undefined
        };
        const existing = rows.find((entry) => entry.id === id);
        if (existing) {
            existing.review = review;
            existing.updatedAt = now;
            this.writeAll(rows);
            return;
        }
        rows.unshift({
            id,
            runId,
            nodeId,
            stepId: nodeId,
            intentId: String(event?.intentId || '').trim() || undefined,
            prompt: 'Approval required',
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            source: 'approvalReviewReady',
            review
        });
        this.writeAll(rows);
    }

    private markResolvedByDecision(event: any): void {
        const runId = String(event?.runId || '').trim();
        const nodeId = String(event?.nodeId || '').trim();
        if (!runId || !nodeId) return;
        const rows = this.readAll();
        const row = rows.find((entry) => entry.id === this.approvalId(runId, nodeId));
        if (!row) return;
        row.status = 'resolved';
        row.decision = event?.decision === 'reject' ? 'reject' : 'approve';
        row.approvedPaths = Array.isArray(event?.approvedPaths) ? event.approvedPaths : undefined;
        row.updatedAt = Date.now();
        this.writeAll(rows);
    }

    private readAll(): PendingApproval[] {
        const parsed = safeReadJson(this.filePath);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed as PendingApproval[];
    }

    private writeAll(rows: PendingApproval[]): void {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    }
}
