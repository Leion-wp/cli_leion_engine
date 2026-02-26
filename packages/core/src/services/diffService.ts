import * as cp from 'child_process';
import { CoreRuntime } from '../coreRuntime';
import { HistoryService } from '../historyService';

export type DiffResult = {
    source: 'audit' | 'git' | 'none';
    lines: string[];
};

export class DiffService {
    private readonly history: HistoryService;

    constructor(private readonly runtime: CoreRuntime) {
        this.history = new HistoryService(runtime);
    }

    async get_run_diff(runId: string): Promise<DiffResult> {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId) {
            return { source: 'none', lines: [] };
        }

        const audit = await this.history.export_run_audit(normalizedRunId);
        const reviews = Array.isArray(audit?.audit?.reviews) ? audit.audit.reviews : [];
        if (reviews.length > 0) {
            const lines: string[] = [];
            for (const review of reviews) {
                lines.push(`review: +${Number(review?.totalAdded || 0)} / -${Number(review?.totalRemoved || 0)}`);
                const files = Array.isArray(review?.files) ? review.files : [];
                for (const file of files) {
                    lines.push(`  ${String(file?.path || '-')}: +${Number(file?.added || 0)} / -${Number(file?.removed || 0)}`);
                }
                if (Array.isArray(review?.policyViolations) && review.policyViolations.length > 0) {
                    lines.push(`  policy violations: ${review.policyViolations.join(', ')}`);
                }
            }
            return { source: 'audit', lines };
        }

        return this.get_git_diff_fallback();
    }

    get_git_diff_fallback(): DiffResult {
        const workspaceRoot = this.runtime.get_workspace_root();
        try {
            const output = cp.execSync('git diff --name-status --no-color', {
                cwd: workspaceRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'utf8'
            });
            const lines = String(output || '')
                .split('\n')
                .map((entry) => entry.trim())
                .filter(Boolean);
            return lines.length > 0 ? { source: 'git', lines } : { source: 'none', lines: [] };
        } catch {
            return { source: 'none', lines: [] };
        }
    }
}

