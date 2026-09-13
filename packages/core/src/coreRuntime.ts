import * as fs from 'fs';
import * as path from 'path';
import { readPipelineSource } from './pipelineSource';
import {
    CoreHostPorts,
    Uri,
    commands,
    resetHostPorts,
    setConfigEntries,
    setHostPorts
} from './ports/vscodeShim';

export type CoreRuntimeOptions = {
    workspaceRoot?: string;
    hostPorts?: CoreHostPorts;
    blockedIntentPrefixes?: string[];
};

export type RunPipelineOptions = {
    dryRun?: boolean;
    from?: string;
    startStepId?: string;
    context?: any;
};

function flattenConfig(prefix: string, input: any, output: Record<string, any>): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        output[prefix] = input;
        return;
    }
    for (const [key, value] of Object.entries(input)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenConfig(nextPrefix, value, output);
        } else {
            output[nextPrefix] = value;
        }
    }
}

function loadWorkspaceConfig(workspaceRoot: string): Record<string, any> {
    const configPath = path.join(workspaceRoot, '.intent-router', 'config.json');
    if (!fs.existsSync(configPath)) {
        return {};
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries: Record<string, any> = {};
        if (parsed && typeof parsed === 'object' && parsed.intentRouter && typeof parsed.intentRouter === 'object') {
            flattenConfig('intentRouter', parsed.intentRouter, entries);
            if ((parsed as any).leionRoots && typeof (parsed as any).leionRoots === 'object') {
                flattenConfig('leionRoots', (parsed as any).leionRoots, entries);
            }
            return entries;
        }
        for (const [key, value] of Object.entries(parsed || {})) {
            if (key.startsWith('intentRouter.') || key.startsWith('leionRoots.')) {
                entries[key] = value;
                continue;
            }
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                flattenConfig(`intentRouter.${key}`, value, entries);
            } else {
                entries[`intentRouter.${key}`] = value;
            }
        }
        return entries;
    } catch {
        return {};
    }
}

function collectIntentNames(value: any, output: string[]): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    const intent = String((value as any).intent || '').trim();
    if (intent) {
        output.push(intent);
    }
    const steps = Array.isArray((value as any).steps) ? (value as any).steps : [];
    for (const step of steps) {
        collectIntentNames(step, output);
    }
}

export class CoreRuntime {
    private readonly workspaceRoot: string;
    private readonly blockedIntentPrefixes: string[];
    private readonly loaded: {
        routeIntent: (intent: any, variableCache?: Map<string, string>) => Promise<any>;
        runPipelineFromData: (pipeline: any, dryRun: boolean, startStepId?: string, context?: any) => Promise<any>;
        readPipelineFromUri: (uri: Uri) => Promise<any>;
        cancelCurrentPipeline: () => void;
        pauseCurrentPipeline: () => void;
        resumeCurrentPipeline: () => void;
        resolveDecision: (nodeId: string, decision: 'approve' | 'reject', runId?: string, approvedPaths?: string[]) => void;
        historyManager: {
            whenReady: () => Promise<void>;
            getHistory: () => any[];
            buildRunAuditExport: (runId: string) => any;
            clearHistory: () => Promise<void>;
        };
        RuntimeTriggerManager: new (context: any) => {
            start: () => Promise<void>;
            refresh: () => Promise<void>;
            dispose: () => void;
        };
    };

    private triggerManager: {
        start: () => Promise<void>;
        refresh: () => Promise<void>;
        dispose: () => void;
    } | undefined;

    constructor(options: CoreRuntimeOptions = {}) {
        this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
        this.blockedIntentPrefixes = Array.isArray(options.blockedIntentPrefixes) && options.blockedIntentPrefixes.length > 0
            ? options.blockedIntentPrefixes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
            : ['vscode.'];

        resetHostPorts();
        const configEntries = loadWorkspaceConfig(this.workspaceRoot);
        setConfigEntries(configEntries);
        setHostPorts({
            workspaceRoot: this.workspaceRoot,
            ...(options.hostPorts || {})
        });

        const registry = require('./registry');
        registry.resetRegistry();

        const context = { subscriptions: [] as any[] };
        const terminalAdapter = require('./providers/terminalAdapter');
        const systemAdapter = require('./providers/systemAdapter');
        const policyAdapter = require('./providers/policyAdapter');
        const aiAdapter = require('./providers/aiAdapter');
        const httpAdapter = require('./providers/httpAdapter');
        const githubAdapter = require('./providers/githubAdapter');
        const gitAdapter = require('./providers/gitAdapter');
        const dockerAdapter = require('./providers/dockerAdapter');
        const julesAdapter = require('./providers/julesAdapter');

        gitAdapter.registerGitProvider(context);
        dockerAdapter.registerDockerProvider(context);
        terminalAdapter.registerTerminalProvider(context);
        systemAdapter.registerSystemProvider(context);
        policyAdapter.registerPolicyProvider(context);
        aiAdapter.registerAiProvider(context);
        httpAdapter.registerHttpProvider(context);
        githubAdapter.registerGitHubProvider(context);
        julesAdapter.registerJulesProvider(context);

        commands.registerCommand('intentRouter.internal.terminalRun', async (args: any) => {
            return await terminalAdapter.executeTerminalCommand(args);
        });
        commands.registerCommand('intentRouter.internal.terminalCancel', async (args: any) => {
            terminalAdapter.cancelTerminalRun(args?.runId);
        });
        commands.registerCommand('intentRouter.internal.aiGenerate', async (args: any) => {
            return await aiAdapter.executeAiCommand(args);
        });
        commands.registerCommand('intentRouter.internal.aiTeam', async (args: any) => {
            return await aiAdapter.executeAiTeamCommand(args);
        });
        commands.registerCommand('intentRouter.internal.httpRequest', async (args: any) => {
            return await httpAdapter.executeHttpCommand(args);
        });
        commands.registerCommand('intentRouter.internal.githubOpenPr', async (args: any) => {
            return await githubAdapter.executeGitHubOpenPr(args);
        });
        commands.registerCommand('intentRouter.internal.githubPrChecks', async (args: any) => {
            return await githubAdapter.executeGitHubPrChecks(args);
        });
        commands.registerCommand('intentRouter.internal.githubPrRerunFailedChecks', async (args: any) => {
            return await githubAdapter.executeGitHubPrRerunFailedChecks(args);
        });
        commands.registerCommand('intentRouter.internal.githubPrComment', async (args: any) => {
            return await githubAdapter.executeGitHubPrComment(args);
        });

        const router = require('./router');
        const pipelineRunner = require('./pipelineRunner');
        const historyModule = require('./historyManager');
        const triggerModule = require('./runtimeTriggerManager');

        this.loaded = {
            routeIntent: router.routeIntent,
            runPipelineFromData: pipelineRunner.runPipelineFromData,
            readPipelineFromUri: pipelineRunner.readPipelineFromUri,
            cancelCurrentPipeline: pipelineRunner.cancelCurrentPipeline,
            pauseCurrentPipeline: pipelineRunner.pauseCurrentPipeline,
            resumeCurrentPipeline: pipelineRunner.resumeCurrentPipeline,
            resolveDecision: pipelineRunner.resolveDecision,
            historyManager: historyModule.historyManager,
            RuntimeTriggerManager: triggerModule.RuntimeTriggerManager
        };
    }

    private assertAllowedIntents(input: any): void {
        const intents: string[] = [];
        collectIntentNames(input, intents);
        for (const entry of intents) {
            const normalized = entry.toLowerCase();
            if (this.blockedIntentPrefixes.some((prefix) => normalized.startsWith(prefix))) {
                throw new Error(`Intent blocked in CLI runtime: ${entry}`);
            }
        }
    }

    async route_intent(intent: any, options?: { variableCache?: Map<string, string> }): Promise<any> {
        this.assertAllowedIntents(intent);
        const meta = {
            ...(intent?.meta || {}),
            runId: String(intent?.meta?.runId || `route_${Date.now().toString(36)}`),
            traceId: String(intent?.meta?.traceId || `trace_${Math.random().toString(36).slice(2, 10)}`)
        };
        return await this.loaded.routeIntent({ ...intent, meta }, options?.variableCache);
    }

    async run_pipeline_data(pipeline: any, options: RunPipelineOptions = {}): Promise<any> {
        this.assertAllowedIntents(pipeline);
        const dryRun = options.dryRun === true;
        const startStepId = String(options.from || options.startStepId || '').trim() || undefined;
        return await this.loaded.runPipelineFromData(pipeline, dryRun, startStepId, options.context);
    }

    async run_pipeline_file(pipelinePath: string, options: RunPipelineOptions = {}): Promise<any> {
        const source = readPipelineSource(this.workspaceRoot, pipelinePath);
        let pipeline: any;
        try { pipeline = JSON.parse(source.bytes.toString('utf8')); } catch { /* handled below */ }
        if (!pipeline || !Array.isArray(pipeline.steps)) throw new Error(`Unable to read pipeline: ${source.path}`);
        return await this.run_pipeline_data(pipeline, options);
    }

    pause(_runId?: string): void {
        this.loaded.pauseCurrentPipeline();
    }

    resume(_runId?: string): void {
        this.loaded.resumeCurrentPipeline();
    }

    cancel(_runId?: string): void {
        this.loaded.cancelCurrentPipeline();
        const runId = String(_runId || '').trim();
        if (runId) {
            void commands.executeCommand('intentRouter.internal.terminalCancel', { runId });
        }
    }

    resolve_decision(nodeId: string, decision: 'approve' | 'reject', runId?: string, approvedPaths?: string[]): void {
        this.loaded.resolveDecision(nodeId, decision, runId, approvedPaths);
    }

    async start_triggers(): Promise<void> {
        if (this.triggerManager) {
            return;
        }
        this.triggerManager = new this.loaded.RuntimeTriggerManager({ subscriptions: [] });
        await this.triggerManager.start();
    }

    async stop_triggers(): Promise<void> {
        if (!this.triggerManager) {
            return;
        }
        this.triggerManager.dispose();
        this.triggerManager = undefined;
    }

    async refresh_triggers(): Promise<void> {
        if (!this.triggerManager) {
            return;
        }
        await this.triggerManager.refresh();
    }

    get_history_manager(): {
        whenReady: () => Promise<void>;
        getHistory: () => any[];
        buildRunAuditExport: (runId: string) => any;
        clearHistory: () => Promise<void>;
    } {
        return this.loaded.historyManager;
    }

    get_workspace_root(): string {
        return this.workspaceRoot;
    }
}
