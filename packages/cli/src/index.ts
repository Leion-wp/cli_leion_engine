#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as readline from 'readline/promises';
import { Command } from 'commander';

const core: any = require('../../core/out/index');

function getWorkspaceRoot(flags: Record<string, string | boolean>): string {
    const fromFlag = String(flags.workspace || '').trim();
    if (fromFlag) {
        return path.resolve(fromFlag);
    }
    return process.cwd();
}

function resolvePipelineRuntimePath(workspaceRoot: string, pipelineRef: string): string {
    const raw = String(pipelineRef || '').trim();
    if (!raw) {
        throw new Error('Pipeline reference is required.');
    }
    const withExt = raw.endsWith('.intent.json') ? raw : `${raw}.intent.json`;
    if (path.isAbsolute(withExt)) {
        return path.resolve(withExt);
    }
    const hasDirectory = withExt.includes('/') || withExt.includes('\\');
    if (hasDirectory) {
        return path.resolve(workspaceRoot, withExt);
    }
    return path.resolve(workspaceRoot, 'pipeline', withExt);
}

function asBool(value: string | boolean | undefined): boolean {
    if (value === true) return true;
    const raw = String(value || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

async function readAllStdin(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

async function readYamlArg(flags: Record<string, string | boolean>): Promise<string> {
    const raw = flags.yaml;
    if (raw === undefined) {
        throw new Error('Missing --yaml <payload|->');
    }
    const value = String(raw);
    if (value === '-') {
        const content = await readAllStdin();
        if (!content.trim()) {
            throw new Error('stdin is empty for --yaml -');
        }
        return content;
    }
    return value;
}

async function askInput(prompt: string, defaultValue?: string): Promise<string | undefined> {
    if (!process.stdin.isTTY) {
        return defaultValue;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const suffix = defaultValue !== undefined ? ` [default: ${defaultValue}]` : '';
        const answer = await rl.question(`${prompt}${suffix}: `);
        const trimmed = String(answer || '').trim();
        if (!trimmed && defaultValue !== undefined) {
            return defaultValue;
        }
        return trimmed || undefined;
    } finally {
        rl.close();
    }
}

async function askChoice(title: string, options: string[], defaultIndex = 0): Promise<string | undefined> {
    if (!options.length) {
        return undefined;
    }
    if (!process.stdin.isTTY) {
        return options[Math.max(0, Math.min(defaultIndex, options.length - 1))];
    }
    console.log(title);
    options.forEach((entry, index) => {
        console.log(`  ${index + 1}. ${entry}`);
    });
    const selected = await askInput('Select option number', String(defaultIndex + 1));
    const parsed = Number(selected || defaultIndex + 1);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > options.length) {
        return options[defaultIndex];
    }
    return options[Math.floor(parsed) - 1];
}

async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
    const defaultLabel = defaultYes ? 'y' : 'n';
    const answer = await askInput(`${prompt} (y/n)`, defaultLabel);
    const raw = String(answer || defaultLabel).trim().toLowerCase();
    if (!raw) return defaultYes;
    return raw === 'y' || raw === 'yes' || raw === '1' || raw === 'true';
}

function toYamlScalar(value: any): string {
    if (value === undefined || value === null) return "''";
    const text = String(value);
    if (!text) return "''";
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `'${escaped}'`;
}

function buildNodeYaml(node: {
    type: string;
    node_position: string;
    description?: string;
    on_failure?: string;
    intent?: string;
    payload?: any;
}): string {
    const lines: string[] = [];
    lines.push(`type: ${node.type}`);
    lines.push(`node_position: ${toYamlScalar(node.node_position)}`);
    if (node.description) lines.push(`description: ${toYamlScalar(node.description)}`);
    if (node.on_failure) lines.push(`on_failure: ${toYamlScalar(node.on_failure)}`);
    if (node.intent) lines.push(`intent: ${toYamlScalar(node.intent)}`);
    if (node.payload !== undefined) {
        lines.push('payload:');
        lines.push(`  ${JSON.stringify(node.payload)}`);
    }
    return lines.join('\n');
}

async function buildInteractiveNodeYaml(existingIds: Set<string>): Promise<string | undefined> {
    const type = await askChoice(
        'Node type',
        ['action', 'script', 'http', 'prompt', 'switch', 'loop', 'sub_pipeline'],
        0
    );
    if (!type) return undefined;

    let nodePosition = '';
    while (!nodePosition) {
        const proposed = await askInput('node_position (unique step id)');
        const normalized = String(proposed || '').trim();
        if (!normalized) {
            process.stderr.write('node_position is required.\n');
            continue;
        }
        if (existingIds.has(normalized)) {
            process.stderr.write(`node_position "${normalized}" already exists.\n`);
            continue;
        }
        nodePosition = normalized;
    }

    const description = await askInput('description (optional)');
    const onFailure = await askInput('on_failure target id (optional)');

    if (type === 'action') {
        const intent = String(await askInput('intent (ex: terminal.run)', 'terminal.run') || 'terminal.run').trim();
        if (!intent || intent.toLowerCase().startsWith('vscode.')) {
            throw new Error('Interactive add_node rejects empty or vscode.* intent.');
        }
        const payloadRaw = await askInput('payload JSON (optional)', '{}');
        let payload: any = {};
        if (String(payloadRaw || '').trim()) {
            payload = JSON.parse(String(payloadRaw || '{}'));
        }
        return buildNodeYaml({
            type: 'action',
            node_position: nodePosition,
            description: description || undefined,
            on_failure: onFailure || undefined,
            intent,
            payload
        });
    }

    if (type === 'script') {
        const scriptPath = String(await askInput('script_path', './script.sh') || './script.sh').trim();
        return [
            `type: script`,
            `node_position: ${toYamlScalar(nodePosition)}`,
            ...(description ? [`description: ${toYamlScalar(description)}`] : []),
            ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
            `script_path: ${toYamlScalar(scriptPath)}`
        ].join('\n');
    }

    if (type === 'http') {
        const url = String(await askInput('url', 'https://example.com') || 'https://example.com').trim();
        const method = String(await askInput('method', 'GET') || 'GET').trim().toUpperCase();
        return [
            `type: http`,
            `node_position: ${toYamlScalar(nodePosition)}`,
            ...(description ? [`description: ${toYamlScalar(description)}`] : []),
            ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
            `url: ${toYamlScalar(url)}`,
            `method: ${toYamlScalar(method)}`
        ].join('\n');
    }

    if (type === 'prompt') {
        const name = String(await askInput('name (variable key)', 'input_var') || 'input_var').trim();
        const value = String(await askInput('value (default)', '') || '').trim();
        return [
            `type: prompt`,
            `node_position: ${toYamlScalar(nodePosition)}`,
            ...(description ? [`description: ${toYamlScalar(description)}`] : []),
            ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
            `name: ${toYamlScalar(name)}`,
            `value: ${toYamlScalar(value)}`
        ].join('\n');
    }

    if (type === 'sub_pipeline') {
        const pipelinePath = String(await askInput('pipeline_path', './pipeline/child.intent.json') || './pipeline/child.intent.json').trim();
        return [
            `type: sub_pipeline`,
            `node_position: ${toYamlScalar(nodePosition)}`,
            ...(description ? [`description: ${toYamlScalar(description)}`] : []),
            ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
            `pipeline_path: ${toYamlScalar(pipelinePath)}`
        ].join('\n');
    }

    if (type === 'loop') {
        const pipelinePath = String(await askInput('pipeline_path (optional child)', '') || '').trim();
        return [
            `type: loop`,
            `node_position: ${toYamlScalar(nodePosition)}`,
            ...(description ? [`description: ${toYamlScalar(description)}`] : []),
            ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
            ...(pipelinePath ? [`pipeline_path: ${toYamlScalar(pipelinePath)}`] : [])
        ].join('\n');
    }

    const variableKey = String(await askInput('variable_key', 'route_key') || 'route_key').trim();
    const defaultStepId = String(await askInput('default_step_id (optional)', '') || '').trim();
    return [
        `type: switch`,
        `node_position: ${toYamlScalar(nodePosition)}`,
        ...(description ? [`description: ${toYamlScalar(description)}`] : []),
        ...(onFailure ? [`on_failure: ${toYamlScalar(onFailure)}`] : []),
        `variable_key: ${toYamlScalar(variableKey)}`,
        ...(defaultStepId ? [`default_step_id: ${toYamlScalar(defaultStepId)}`] : [])
    ].join('\n');
}

function createRuntime(workspaceRoot: string, verbose: boolean): any {
    const blockedIntentPrefixes = ['vscode.'];
    return new core.CoreRuntime({
        workspaceRoot,
        blockedIntentPrefixes,
        hostPorts: {
            workspaceRoot,
            event_sink: {
                log: (channel: string, line: string) => {
                    if (verbose) {
                        process.stdout.write(`[${channel}] ${line}\n`);
                    }
                },
                info: (message: string) => {
                    if (verbose) process.stdout.write(`[info] ${message}\n`);
                },
                warn: (message: string) => {
                    process.stderr.write(`[warn] ${message}\n`);
                },
                error: (message: string) => {
                    process.stderr.write(`[error] ${message}\n`);
                }
            },
            interaction: {
                showInputBox: async (options: any) => {
                    return await askInput(String(options?.prompt || options?.placeHolder || 'Input'));
                },
                showQuickPick: async (items: any[], options: any) => {
                    const labels = (items || []).map((entry) => {
                        if (typeof entry === 'string') return entry;
                        return String(entry?.label || 'option');
                    });
                    const selected = await askChoice(String(options?.placeHolder || 'Choose one'), labels, 0);
                    if (selected === undefined) return undefined;
                    const index = labels.indexOf(selected);
                    return index >= 0 ? items[index] : undefined;
                },
                showInformationMessage: async (message: string, _options?: any, ...items: any[]) => {
                    if (!items.length) {
                        if (verbose) process.stdout.write(`${message}\n`);
                        return undefined;
                    }
                    return await askChoice(message, items.map((entry) => String(entry)), 0);
                },
                showWarningMessage: async (message: string, _options?: any, ...items: any[]) => {
                    process.stderr.write(`${message}\n`);
                    if (!items.length) return undefined;
                    return await askChoice(message, items.map((entry) => String(entry)), 0);
                },
                showErrorMessage: async (message: string, _options?: any, ...items: any[]) => {
                    process.stderr.write(`${message}\n`);
                    if (!items.length) return undefined;
                    return await askChoice(message, items.map((entry) => String(entry)), 0);
                }
            }
        }
    });
}

function loadPipelineStepIds(workspaceRoot: string, pipelineRef: string): Set<string> {
    const filePath = resolvePipelineRuntimePath(workspaceRoot, pipelineRef);
    if (!fs.existsSync(filePath)) {
        return new Set<string>();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    return new Set<string>(steps.map((step: any) => String(step?.id || '').trim()).filter(Boolean));
}

async function runInteractiveAddNodeLoop(workspaceRoot: string, pipelineRef: string, service: any): Promise<void> {
    if (!process.stdin.isTTY) {
        return;
    }
    const existingIds = loadPipelineStepIds(workspaceRoot, pipelineRef);
    const shouldStart = await askYesNo('Add a node now?', true);
    if (!shouldStart) return;

    while (true) {
        const yamlPayload = await buildInteractiveNodeYaml(existingIds);
        if (!yamlPayload) return;
        const result = service.add_node(pipelineRef, yamlPayload);
        const newId = String(result?.pipeline?.steps?.[result.pipeline.steps.length - 1]?.id || '').trim();
        if (newId) existingIds.add(newId);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        const again = await askYesNo('Add another node?', false);
        if (!again) return;
    }
}

async function handleCreatePipeline(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    let name = String(flags.name || '').trim();
    if (!name && asBool(flags.interactive) && process.stdin.isTTY) {
        name = String(await askInput('Pipeline name') || '').trim();
    }
    if (!name) {
        throw new Error('create_pipeline requires --name');
    }
    const description = String(flags.description || '').trim() || undefined;
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.create_pipeline(name, description);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (asBool(flags.interactive)) {
        await runInteractiveAddNodeLoop(workspaceRoot, name, service);
    }
}

async function handleDeletePipeline(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    if (!pipeline) {
        throw new Error('delete_pipeline requires --pipeline');
    }
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.delete_pipeline(pipeline);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleEditPipeline(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    if (!pipeline) {
        throw new Error('edit_pipeline requires --pipeline');
    }
    const yamlPayload = await readYamlArg(flags);
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.edit_pipeline(pipeline, yamlPayload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleAddNode(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    if (!pipeline) {
        throw new Error('add_node requires --pipeline');
    }
    const service = new core.DslMutationService(workspaceRoot);
    if (asBool(flags.interactive)) {
        await runInteractiveAddNodeLoop(workspaceRoot, pipeline, service);
        return;
    }
    const yamlPayload = await readYamlArg(flags);
    const result = service.add_node(pipeline, yamlPayload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleDeleteNode(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    const nodePosition = String(flags.node_position || '').trim();
    if (!pipeline) {
        throw new Error('delete_node requires --pipeline');
    }
    if (!nodePosition) {
        throw new Error('delete_node requires --node_position');
    }
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.delete_node(pipeline, nodePosition);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleReplaceNode(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    if (!pipeline) {
        throw new Error('replace_node requires --pipeline');
    }
    const yamlPayload = await readYamlArg(flags);
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.replace_node(pipeline, yamlPayload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleReorderNodes(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    const orderRaw = String(flags.order || '').trim();
    if (!pipeline) {
        throw new Error('reorder_nodes requires --pipeline');
    }
    if (!orderRaw) {
        throw new Error('reorder_nodes requires --order <id1,id2,...>');
    }
    const orderedNodePositions = orderRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.reorder_nodes(pipeline, orderedNodePositions);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleRunPipeline(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const pipeline = String(flags.pipeline || '').trim();
    const pipelinePath = resolvePipelineRuntimePath(workspaceRoot, pipeline);
    const from = String(flags.from || '').trim() || undefined;
    const dryRun = asBool(flags.dry_run);
    const detached = asBool(flags.detached);
    const verbose = asBool(flags.verbose);

    if (!pipeline) {
        throw new Error('run_pipeline requires --pipeline');
    }

    if (!detached) {
        const runtime = createRuntime(workspaceRoot, verbose);
        const result = await runtime.run_pipeline_file(pipelinePath, {
            dryRun,
            from
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result?.success) {
            process.exitCode = 1;
        }
        return;
    }

    const supervisor = new core.RunSupervisorService(workspaceRoot);
    const result = supervisor.start_detached({
        pipeline,
        from,
        dryRun,
        verbose
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function writeControlCommand(workspaceRoot: string, flags: Record<string, string | boolean>, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const requestedRunId = String(flags.run_id || '').trim();
    if (!requestedRunId) {
        if (action === 'pause') throw new Error('stop_pipeline requires --run_id');
        if (action === 'resume') throw new Error('resume_pipeline requires --run_id');
        throw new Error('cancel_pipeline requires --run_id');
    }
    const supervisor = new core.RunSupervisorService(workspaceRoot);
    let result: any;
    if (action === 'pause') {
        result = supervisor.pause_run(requestedRunId);
    } else if (action === 'resume') {
        result = supervisor.resume_run(requestedRunId);
    } else {
        result = supervisor.cancel_run(requestedRunId);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleRouteIntent(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const raw = String(flags.intent_json || '').trim();
    if (!raw) {
        throw new Error('route_intent requires --intent_json <json|@file>');
    }
    const text = raw.startsWith('@')
        ? fs.readFileSync(path.resolve(workspaceRoot, raw.slice(1)), 'utf8')
        : raw;
    const intent = JSON.parse(text);
    const runtime = createRuntime(workspaceRoot, asBool(flags.verbose));
    const result = await runtime.route_intent(intent);
    process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
}

async function handleHistoryList(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const runtime = createRuntime(workspaceRoot, asBool(flags.verbose));
    const service = new core.HistoryService(runtime);
    const runs = await service.list();
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
}

async function handleHistoryShow(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const runId = String(flags.run_id || '').trim();
    if (!runId) {
        throw new Error('history_show requires --run_id');
    }
    const runtime = createRuntime(workspaceRoot, asBool(flags.verbose));
    const service = new core.HistoryService(runtime);
    const run = await service.show(runId);
    process.stdout.write(`${JSON.stringify(run ?? null, null, 2)}\n`);
}

async function handleHistoryClear(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const runtime = createRuntime(workspaceRoot, asBool(flags.verbose));
    const service = new core.HistoryService(runtime);
    await service.clear();
    process.stdout.write(`${JSON.stringify({ cleared: true }, null, 2)}\n`);
}

async function handleTriggersServe(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const runtime = createRuntime(workspaceRoot, asBool(flags.verbose));
    await runtime.start_triggers();

    const shutdown = async () => {
        await runtime.stop_triggers();
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown();
    });
    process.on('SIGTERM', () => {
        void shutdown();
    });

    process.stdout.write('triggers_serve started\n');
    await new Promise<void>(() => {
        // keep daemon alive
    });
}

async function handleTui(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const tuiEntry = path.resolve(__dirname, '../../tui/out/index.js');
    if (!fs.existsSync(tuiEntry)) {
        throw new Error(`TUI build not found: ${tuiEntry}. Run npm run build:tui.`);
    }
    const args = [tuiEntry, '--workspace', workspaceRoot];
    const runId = String(flags.run_id || '').trim();
    if (runId) args.push('--run_id', runId);
    const pipeline = String(flags.pipeline || '').trim();
    if (pipeline) args.push('--pipeline', pipeline);
    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(process.execPath, args, {
            cwd: workspaceRoot,
            stdio: 'inherit'
        });
        child.on('exit', (code) => {
            if (Number(code || 0) !== 0) {
                reject(new Error(`TUI exited with code ${String(code)}`));
                return;
            }
            resolve();
        });
        child.on('error', reject);
    });
}

function withCommonOptions(command: Command): Command {
    return command
        .option('--workspace <path>', 'Workspace root (default: current directory)')
        .option('--verbose', 'Enable verbose logs');
}

function asFlagMap(input: Record<string, any>): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (value === undefined) continue;
        if (typeof value === 'boolean') {
            if (value) out[key] = true;
            continue;
        }
        out[key] = String(value);
    }
    return out;
}

async function runWithWorkspace(
    options: Record<string, any>,
    fn: (workspaceRoot: string, flags: Record<string, string | boolean>) => Promise<void>
): Promise<void> {
    const flags = asFlagMap(options);
    const workspaceRoot = getWorkspaceRoot(flags);
    await fn(workspaceRoot, flags);
}

function buildProgram(): Command {
    const program = new Command();
    program
        .name('leion-roots')
        .description('Leion Roots CLI')
        .showHelpAfterError('(use --help for usage)')
        .allowExcessArguments(false);

    withCommonOptions(program.command('create_pipeline'))
        .description('Create a new pipeline')
        .option('--name <name>', 'Pipeline name')
        .option('--description <description>', 'Pipeline description')
        .option('--interactive', 'Create then open interactive node wizard')
        .action(async (options) => runWithWorkspace(options, handleCreatePipeline));

    withCommonOptions(program.command('delete_pipeline'))
        .description('Delete a pipeline file')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .action(async (options) => runWithWorkspace(options, handleDeletePipeline));

    withCommonOptions(program.command('edit_pipeline'))
        .description('Replace pipeline steps from YAML payload')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .requiredOption('--yaml <payload|->', 'Inline YAML payload or - for stdin')
        .action(async (options) => runWithWorkspace(options, handleEditPipeline));

    withCommonOptions(program.command('add_node'))
        .description('Add node(s) to pipeline from YAML payload or interactive wizard')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .option('--yaml <payload|->', 'Inline YAML payload or - for stdin')
        .option('--interactive', 'Open interactive node wizard')
        .action(async (options) => {
            if (!options.yaml && !options.interactive) {
                throw new Error('add_node requires --yaml or --interactive');
            }
            await runWithWorkspace(options, handleAddNode);
        });

    withCommonOptions(program.command('delete_node'))
        .description('Delete one node by node_position')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .requiredOption('--node_position <id>', 'Node position (step id)')
        .action(async (options) => runWithWorkspace(options, handleDeleteNode));

    withCommonOptions(program.command('replace_node'))
        .description('Replace one node by node_position using YAML payload')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .requiredOption('--yaml <payload|->', 'Inline YAML payload or - for stdin')
        .action(async (options) => runWithWorkspace(options, handleReplaceNode));

    withCommonOptions(program.command('reorder_nodes'))
        .description('Reorder nodes by ordered node_position list')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .requiredOption('--order <id1,id2,...>', 'Ordered node_position list')
        .action(async (options) => runWithWorkspace(options, handleReorderNodes));

    withCommonOptions(program.command('run_pipeline'))
        .description('Run a pipeline from file')
        .requiredOption('--pipeline <path|name>', 'Pipeline reference')
        .option('--from <node_position>', 'Start from node_position/step.id')
        .option('--dry_run', 'Run in dry run mode')
        .option('--detached', 'Run detached in background')
        .action(async (options) => runWithWorkspace(options, handleRunPipeline));

    withCommonOptions(program.command('stop_pipeline'))
        .description('Request checkpoint pause for a detached pipeline run')
        .requiredOption('--run_id <id>', 'Run id')
        .action(async (options) => runWithWorkspace(options, (workspaceRoot, flags) => writeControlCommand(workspaceRoot, flags, 'pause')));

    withCommonOptions(program.command('resume_pipeline'))
        .description('Resume a checkpoint-paused detached pipeline run')
        .requiredOption('--run_id <id>', 'Run id')
        .action(async (options) => runWithWorkspace(options, (workspaceRoot, flags) => writeControlCommand(workspaceRoot, flags, 'resume')));

    withCommonOptions(program.command('cancel_pipeline'))
        .description('Cancel a detached pipeline run')
        .requiredOption('--run_id <id>', 'Run id')
        .action(async (options) => runWithWorkspace(options, (workspaceRoot, flags) => writeControlCommand(workspaceRoot, flags, 'cancel')));

    withCommonOptions(program.command('route_intent'))
        .description('Resolve and execute one intent JSON payload')
        .requiredOption('--intent_json <json|@file>', 'Inline JSON or @file path')
        .action(async (options) => runWithWorkspace(options, handleRouteIntent));

    withCommonOptions(program.command('history_list'))
        .description('List historical pipeline runs')
        .action(async (options) => runWithWorkspace(options, handleHistoryList));

    withCommonOptions(program.command('history_show'))
        .description('Show one run history entry')
        .requiredOption('--run_id <id>', 'Run id')
        .action(async (options) => runWithWorkspace(options, handleHistoryShow));

    withCommonOptions(program.command('history_clear'))
        .description('Clear runtime history')
        .action(async (options) => runWithWorkspace(options, handleHistoryClear));

    withCommonOptions(program.command('triggers_serve'))
        .description('Start trigger daemon')
        .action(async (options) => runWithWorkspace(options, handleTriggersServe));

    withCommonOptions(program.command('tui'))
        .description('Start Leion TUI')
        .option('--run_id <id>', 'Open run-focused mode')
        .option('--pipeline <path|name>', 'Open pipeline-focused mode')
        .action(async (options) => runWithWorkspace(options, handleTui));

    return program;
}

async function main(): Promise<void> {
    const program = buildProgram();
    await program.parseAsync(process.argv);
}

main().catch((error: any) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exit(1);
});
