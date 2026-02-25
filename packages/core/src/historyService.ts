import { CoreRuntime } from './coreRuntime';

export class HistoryService {
    constructor(private readonly runtime: CoreRuntime) {}

    async list(): Promise<any[]> {
        const manager = this.runtime.get_history_manager();
        await manager.whenReady();
        return manager.getHistory();
    }

    async show(runId: string): Promise<any | undefined> {
        const manager = this.runtime.get_history_manager();
        await manager.whenReady();
        const normalized = String(runId || '').trim();
        if (!normalized) {
            return undefined;
        }
        const exported = manager.buildRunAuditExport(normalized);
        if (exported) {
            return exported;
        }
        return manager.getHistory().find((entry: any) => String(entry?.id || '') === normalized);
    }

    async clear(): Promise<void> {
        const manager = this.runtime.get_history_manager();
        await manager.whenReady();
        await manager.clearHistory();
    }

    async export_run_audit(runId: string): Promise<any | undefined> {
        const manager = this.runtime.get_history_manager();
        await manager.whenReady();
        return manager.buildRunAuditExport(String(runId || '').trim());
    }
}
