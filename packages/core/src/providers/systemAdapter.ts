import { systemCapabilities } from '../builtinCapabilities';
import * as vscode from '../ports/vscodeShim';
import * as path from 'path';
import { registerCapabilities } from '../registry';
import { cancelCurrentPipeline, readPipelineFromUri, runPipelineFromData } from '../pipelineRunner';
import { pipelineEventBus } from '../eventBus';

export function registerSystemProvider(context: vscode.ExtensionContext) {
    doRegister();

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemPause', async (args: any) => {
            await executeSystemCommand(args);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemSetVar', async (_args: any) => {
            // Handled in the PipelineRunner (variable cache). Kept for direct invocation compatibility.
            return;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemSetCwd', async (_args: any) => {
            // Handled in the PipelineRunner (current cwd). Kept for direct invocation compatibility.
            return;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemForm', async (_args: any) => {
            // Handled in the PipelineRunner (HITL form -> variable cache). Kept for determinism/policy + compatibility.
            return;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemSwitch', async (_args: any) => {
            // Handled in the PipelineRunner (routing). Kept for determinism/policy + compatibility.
            return;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemSubPipeline', async (args: any) => {
            return await executeSystemSubPipeline(args);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemLoop', async (args: any) => {
            return await executeSystemLoop(args);
        })
    );
}

function doRegister() {
    registerCapabilities(systemCapabilities);
    console.error('[Intent Router] Registered System provider capabilities.');
}

export async function executeSystemCommand(args: any): Promise<void> {
    const message = args?.message || 'Pipeline paused for human review.';

    const selection = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        'Continue',
        'Cancel'
    );

    if (selection !== 'Continue') {
        cancelCurrentPipeline();
        throw new Error('Pipeline aborted by user.');
    }
}

function parseInputVars(args: any): Record<string, string> {
    if (args?.input && typeof args.input === 'object' && !Array.isArray(args.input)) {
        return Object.fromEntries(
            Object.entries(args.input).map(([key, value]) => [String(key), String(value ?? '')])
        );
    }
    const rawInputJson = String(args?.inputJson || '').trim();
    if (!rawInputJson) return {};
    let parsed: any = {};
    try {
        parsed = JSON.parse(rawInputJson);
    } catch (error: any) {
        throw new Error(`Sub-pipeline inputJson is invalid JSON: ${String(error?.message || error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Sub-pipeline inputJson must be a JSON object.');
    }
    return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [String(key), String(value ?? '')])
    );
}

async function executeSystemSubPipeline(args: any): Promise<any> {
    const { childPipeline, rawPipelinePath, depth } = await resolveChildPipeline(args, 'Sub-pipeline');
    const runtimeVariables = parseInputVars(args);
    const dryRunParent = args?.__meta?.dryRun === true;
    const dryRunChild = args?.dryRunChild === true || dryRunParent;
    const childResult = await runPipelineFromData(
        childPipeline,
        dryRunChild,
        undefined,
        {
            source: 'manual',
            runtimeVariables,
            subPipelineDepth: depth
        } as any
    );

    const payload = {
        childStatus: childResult.status,
        childSuccess: childResult.success,
        childRunId: childResult.runId,
        childPipelinePath: rawPipelinePath,
        depth
    };

    return {
        content: JSON.stringify(payload),
        path: rawPipelinePath,
        changes: []
    };
}

function parseLoopItems(raw: any): string[] {
    if (Array.isArray(raw)) {
        return raw.map((entry) => String(entry ?? '')).filter((entry) => entry.length > 0);
    }
    const value = String(raw ?? '').trim();
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.map((entry) => String(entry ?? '')).filter((entry) => entry.length > 0);
        }
    } catch {
        // fall through to csv parsing
    }
    if (value.includes('\n')) {
        return value.split('\n').map((entry) => entry.trim()).filter(Boolean);
    }
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function executeSystemLoop(args: any): Promise<any> {
    const executionMode = String(args?.executionMode || 'child_pipeline').trim().toLowerCase();
    if (executionMode === 'graph_segment') {
        throw new Error('system.loop graph_segment mode is handled by pipeline runner.');
    }
    const { childPipeline, rawPipelinePath, depth } = await resolveChildPipeline(args, 'Loop');
    const baseVars = parseInputVars(args);
    const items = parseLoopItems(args?.items);
    if (!items.length) {
        throw new Error('Loop requires non-empty "items".');
    }
    const maxIterationsRaw = Number(args?.maxIterations || 20);
    const maxCycles = Number.isFinite(maxIterationsRaw) ? Math.max(1, Math.floor(maxIterationsRaw)) : 20;
    const maxItemExecutions = Math.max(1, items.length) * maxCycles;
    const repeatCountRaw = Number(args?.repeatCount || 1);
    const repeatCount = Number.isFinite(repeatCountRaw) ? Math.max(1, Math.floor(repeatCountRaw)) : 1;
    const continueOnChildError = args?.continueOnChildError === true;
    const errorStrategyRaw = String(args?.errorStrategy || '').trim().toLowerCase();
    const errorStrategy = errorStrategyRaw === 'fail_at_end' || errorStrategyRaw === 'threshold'
        ? errorStrategyRaw
        : (continueOnChildError ? 'fail_at_end' : 'fail_fast');
    const errorThresholdRaw = Number(args?.errorThreshold ?? 1);
    const errorThreshold = Number.isFinite(errorThresholdRaw) ? Math.max(1, Math.floor(errorThresholdRaw)) : 1;
    const itemVar = String(args?.itemVar || 'loop_item').trim() || 'loop_item';
    const indexVar = String(args?.indexVar || 'loop_index').trim() || 'loop_index';
    const dryRunParent = args?.__meta?.dryRun === true;
    const dryRunChild = args?.dryRunChild === true || dryRunParent;
    const loopEnabled = vscode.workspace.getConfiguration('intentRouter').get<boolean>('runtime.loop.enabled', true);
    if (!loopEnabled) {
        throw new Error('Loop execution disabled by runtime.loop.enabled=false');
    }
    const maxTotalOpsCfgRaw = Number(vscode.workspace.getConfiguration('intentRouter').get<number>('runtime.loop.maxTotalOps', 500));
    const maxTotalOpsCfg = Number.isFinite(maxTotalOpsCfgRaw) ? Math.max(1, Math.floor(maxTotalOpsCfgRaw)) : 500;
    const maxDurationCfgRaw = Number(vscode.workspace.getConfiguration('intentRouter').get<number>('runtime.loop.maxDurationMs', 900000));
    const maxDurationCfg = Number.isFinite(maxDurationCfgRaw) ? Math.max(1000, Math.floor(maxDurationCfgRaw)) : 900000;
    const loopStartTs = Date.now();
    const runId = String(args?.__meta?.runId || '').trim();
    const intentId = String(args?.__meta?.traceId || '').trim();
    const stepId = String(args?.__meta?.stepId || '').trim();
    const emitLoopLog = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => {
        if (!runId || !intentId) return;
        pipelineEventBus.emit({ type: 'stepLog', runId, intentId, stepId: stepId || undefined, text, stream } as any);
    };

    let successCount = 0;
    let failureCount = 0;
    let lastRunId = '';
    let processedItems = 0;
    let truncated = false;

    for (let cycleIndex = 0; cycleIndex < repeatCount; cycleIndex += 1) {
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            if ((Date.now() - loopStartTs) > maxDurationCfg) {
                throw new Error(`Loop maxDurationMs exceeded (${maxDurationCfg}).`);
            }
            if (processedItems >= maxItemExecutions) {
                truncated = true;
                break;
            }
            if ((processedItems + 1) > maxTotalOpsCfg) {
                throw new Error(`Loop maxTotalOps exceeded (${maxTotalOpsCfg}).`);
            }
            const globalIndex = processedItems;
            emitLoopLog(`[loop] iter=${globalIndex + 1} cycle=${cycleIndex + 1} item="${String(items[itemIndex])}" child=${rawPipelinePath}`);
            const loopVars: Record<string, string> = {
                ...baseVars,
                [itemVar]: String(items[itemIndex]),
                [indexVar]: String(globalIndex),
                loop_cycle: String(cycleIndex)
            };
            const childResult = await runPipelineFromData(
                childPipeline,
                dryRunChild,
                undefined,
                {
                    source: 'manual',
                    runtimeVariables: loopVars,
                    subPipelineDepth: depth
                } as any
            );
            processedItems += 1;
            lastRunId = childResult.runId;
            if (childResult.success) {
                successCount += 1;
                continue;
            }
            failureCount += 1;
            const abortNow = errorStrategy === 'fail_fast'
                || (errorStrategy === 'threshold' && failureCount > errorThreshold);
            if (abortNow) {
                throw new Error(`Loop child failed at index ${globalIndex} (item="${String(items[itemIndex])}")`);
            }
        }
        if (truncated) break;
    }
    if (errorStrategy === 'fail_at_end' && failureCount > 0) {
        throw new Error(`Loop completed with ${failureCount} failure(s) under fail_at_end strategy.`);
    }
    emitLoopLog(`[loop] summary processed=${processedItems} success=${successCount} failure=${failureCount} truncated=${truncated}`);

    const payload = {
        childPipelinePath: rawPipelinePath,
        totalItems: items.length,
        repeatCount,
        processedItems,
        truncated,
        successCount,
        failureCount,
        maxCycles,
        maxItemExecutions,
        errorStrategy,
        errorThreshold,
        maxTotalOps: maxTotalOpsCfg,
        maxDurationMs: maxDurationCfg,
        depth,
        lastRunId
    };

    return {
        content: JSON.stringify(payload),
        path: rawPipelinePath,
        changes: []
    };
}

async function resolveChildPipeline(args: any, operationLabel: string): Promise<{ childPipeline: any; rawPipelinePath: string; depth: number }> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error(`${operationLabel} execution requires an opened workspace.`);
    }
    const rawPipelinePath = String(args?.pipelinePath || '').trim();
    if (!rawPipelinePath) {
        throw new Error(`${operationLabel} requires "pipelinePath".`);
    }
    const currentCwd = String(args?.__meta?.cwd || workspaceRoot).trim() || workspaceRoot;
    const candidate = path.isAbsolute(rawPipelinePath)
        ? path.normalize(rawPipelinePath)
        : path.resolve(currentCwd, rawPipelinePath);
    const trustedWorkspace = path.resolve(workspaceRoot);
    const trustedPrefix = trustedWorkspace.endsWith(path.sep) ? trustedWorkspace : `${trustedWorkspace}${path.sep}`;
    const normalizedCandidate = path.resolve(candidate);
    if (normalizedCandidate !== trustedWorkspace && !normalizedCandidate.startsWith(trustedPrefix)) {
        throw new Error(`${operationLabel} path must stay inside workspace: ${rawPipelinePath}`);
    }

    const currentDepthRaw = Number(args?.__meta?.subPipelineDepth || 0);
    const currentDepth = Number.isFinite(currentDepthRaw) ? Math.max(0, Math.floor(currentDepthRaw)) : 0;
    const maxDepthRaw = vscode.workspace.getConfiguration('intentRouter').get<number>('runtime.subPipeline.maxDepth', 4);
    const maxDepth = Number.isFinite(Number(maxDepthRaw)) ? Math.max(1, Math.floor(Number(maxDepthRaw))) : 4;
    if (currentDepth >= maxDepth) {
        throw new Error(`${operationLabel} max depth reached (${maxDepth}).`);
    }

    const uri = vscode.Uri.file(normalizedCandidate);
    const childPipeline = await readPipelineFromUri(uri);
    if (!childPipeline) {
        throw new Error(`Unable to read child pipeline: ${rawPipelinePath}`);
    }
    return { childPipeline, rawPipelinePath, depth: currentDepth + 1 };
}
