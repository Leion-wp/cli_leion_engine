import { CoreRuntime } from '../coreRuntime';
import { PipelineCatalogService } from './pipelineCatalogService';

export type TriggerDescriptor = {
    id: string;
    kind: 'cron' | 'webhook' | 'watch';
    pipelineName: string;
    pipelinePath: string;
    stepId: string;
    intent: string;
    enabled: boolean;
    payload: any;
};

function normalizeKind(intent: string): 'cron' | 'webhook' | 'watch' | undefined {
    if (intent === 'system.trigger.cron') return 'cron';
    if (intent === 'system.trigger.webhook') return 'webhook';
    if (intent === 'system.trigger.watch') return 'watch';
    return undefined;
}

export class TriggerService {
    private readonly catalog: PipelineCatalogService;

    constructor(private readonly runtime: CoreRuntime) {
        this.catalog = new PipelineCatalogService(runtime.get_workspace_root());
    }

    list(): TriggerDescriptor[] {
        const pipelines = this.catalog.list();
        const rows: TriggerDescriptor[] = [];
        for (const pipeline of pipelines) {
            try {
                const parsed: any = this.catalog.load(pipeline.path);
                const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
                for (let index = 0; index < steps.length; index += 1) {
                    const step = steps[index];
                    const intent = String(step?.intent || '').trim();
                    const kind = normalizeKind(intent);
                    if (!kind) continue;
                    const stepId = String(step?.id || '').trim() || `trigger_${index}`;
                    const payload = step?.payload || {};
                    rows.push({
                        id: `${pipeline.path}:${stepId}`,
                        kind,
                        pipelineName: pipeline.name,
                        pipelinePath: pipeline.path,
                        stepId,
                        intent,
                        enabled: payload?.enabled !== false,
                        payload
                    });
                }
            } catch {
                // ignore malformed pipeline
            }
        }
        return rows;
    }

    async start(): Promise<void> {
        await this.runtime.start_triggers();
    }

    async stop(): Promise<void> {
        await this.runtime.stop_triggers();
    }

    async refresh(): Promise<void> {
        await this.runtime.refresh_triggers();
    }
}

