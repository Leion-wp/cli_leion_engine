#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as readline from 'readline/promises';

const core: any = require('../../core/out/index');

type ParsedArgs = {
    command: string;
    flags: Record<string, string | boolean>;
    positionals: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
    const flags: Record<string, string | boolean> = {};
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[index + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                index += 1;
            } else {
                flags[key] = true;
            }
            continue;
        }
        positionals.push(token);
    }

    return {
        command: String(positionals[0] || '').trim(),
        flags,
        positionals
    };
}

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

function getRunsDir(workspaceRoot: string): string {
    const dir = path.join(workspaceRoot, '.intent-router', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function stateFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${detachedRunId}.json`);
}

function ctrlFilePath(workspaceRoot: string, detachedRunId: string): string {
    return path.join(getRunsDir(workspaceRoot), `${detachedRunId}.ctrl.json`);
}

function writeJson(filePath: string, value: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function generateDetachedRunId(): string {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function findRunState(workspaceRoot: string, runId: string): { filePath: string; state: any } | undefined {
    const normalized = String(runId || '').trim();
    if (!normalized) return undefined;
    const dir = getRunsDir(workspaceRoot);
    const files = fs.readdirSync(dir).filter((entry) => entry.endsWith('.json') && !entry.endsWith('.ctrl.json'));
    for (const fileName of files) {
        const filePath = path.join(dir, fileName);
        try {
            const state = readJson(filePath);
            if (
                String(state?.detachedRunId || '') === normalized
                || String(state?.pipelineRunId || '') === normalized
            ) {
                return { filePath, state };
            }
        } catch {
            // ignore malformed state files
        }
    }
    return undefined;
}

async function handleCreatePipeline(workspaceRoot: string, flags: Record<string, string | boolean>): Promise<void> {
    const name = String(flags.name || '').trim();
    if (!name) {
        throw new Error('create_pipeline requires --name');
    }
    const description = String(flags.description || '').trim() || undefined;
    const service = new core.DslMutationService(workspaceRoot);
    const result = service.create_pipeline(name, description);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    const yamlPayload = await readYamlArg(flags);
    const service = new core.DslMutationService(workspaceRoot);
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

async function runWorker(flags: Record<string, string | boolean>): Promise<void> {
    const workspaceRoot = getWorkspaceRoot(flags);
    const verbose = asBool(flags.verbose);
    const detachedRunId = String(flags.run_id || '').trim();
    const pipeline = String(flags.pipeline || '').trim();
    const pipelinePath = resolvePipelineRuntimePath(workspaceRoot, pipeline);
    const from = String(flags.from || '').trim() || undefined;
    const dryRun = asBool(flags.dry_run);

    if (!detachedRunId || !pipeline) {
        throw new Error('__worker_run requires --run_id and --pipeline');
    }

    const runtime = createRuntime(workspaceRoot, verbose);
    const statePath = stateFilePath(workspaceRoot, detachedRunId);
    const controlPath = ctrlFilePath(workspaceRoot, detachedRunId);
    const eventBus = require('../../core/out/eventBus').pipelineEventBus;

    let lastControlTimestamp = 0;
    const disposable = eventBus.on((event: any) => {
        if (event?.type !== 'pipelineStart') return;
        const state = fs.existsSync(statePath) ? readJson(statePath) : {};
        state.pipelineRunId = String(event.runId || '');
        state.status = 'running';
        state.updatedAt = Date.now();
        writeJson(statePath, state);
    });

    const interval = setInterval(() => {
        if (!fs.existsSync(controlPath)) {
            return;
        }
        try {
            const control = readJson(controlPath);
            const updatedAt = Number(control?.updatedAt || 0);
            if (!Number.isFinite(updatedAt) || updatedAt <= lastControlTimestamp) {
                return;
            }
            lastControlTimestamp = updatedAt;
            const action = String(control?.action || '').trim();
            const state = fs.existsSync(statePath) ? readJson(statePath) : {};
            const targetRunId = String(state?.pipelineRunId || detachedRunId);
            if (action === 'pause') runtime.pause(targetRunId);
            if (action === 'resume') runtime.resume(targetRunId);
            if (action === 'cancel' || action === 'stop') runtime.cancel(targetRunId);
        } catch {
            // ignore malformed control state
        }
    }, 300);

    try {
        const result = await runtime.run_pipeline_file(pipelinePath, {
            dryRun,
            from
        });
        const state = fs.existsSync(statePath) ? readJson(statePath) : {};
        state.status = result?.status || (result?.success ? 'success' : 'failure');
        state.result = result;
        state.updatedAt = Date.now();
        state.endedAt = Date.now();
        writeJson(statePath, state);
        process.exit(result?.success ? 0 : 1);
    } catch (error: any) {
        const state = fs.existsSync(statePath) ? readJson(statePath) : {};
        state.status = 'failure';
        state.error = String(error?.message || error || 'Unknown worker failure');
        state.updatedAt = Date.now();
        state.endedAt = Date.now();
        writeJson(statePath, state);
        process.exit(1);
    } finally {
        clearInterval(interval);
        try {
            disposable.dispose();
        } catch {
            // noop
        }
    }
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

    const detachedRunId = generateDetachedRunId();
    const state = {
        detachedRunId,
        workspaceRoot,
        pipeline,
        from,
        dryRun,
        status: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    writeJson(stateFilePath(workspaceRoot, detachedRunId), state);

    const cliEntry = path.resolve(__dirname, 'index.js');
    const args = [cliEntry, '__worker_run', '--run_id', detachedRunId, '--pipeline', pipeline, '--workspace', workspaceRoot];
    if (from) args.push('--from', from);
    if (dryRun) args.push('--dry_run');
    if (verbose) args.push('--verbose');

    const child = cp.spawn(process.execPath, args, {
        cwd: workspaceRoot,
        detached: true,
        stdio: 'ignore'
    });
    child.unref();

    const nextState = readJson(stateFilePath(workspaceRoot, detachedRunId));
    nextState.pid = child.pid;
    nextState.updatedAt = Date.now();
    writeJson(stateFilePath(workspaceRoot, detachedRunId), nextState);

    process.stdout.write(`${JSON.stringify({ run_id: detachedRunId, pid: child.pid, status: 'detached' }, null, 2)}\n`);
}

async function writeControlCommand(workspaceRoot: string, flags: Record<string, string | boolean>, action: 'pause' | 'resume'): Promise<void> {
    const requestedRunId = String(flags.run_id || '').trim();
    if (!requestedRunId) {
        throw new Error(`${action === 'pause' ? 'stop_pipeline' : 'resume_pipeline'} requires --run_id`);
    }
    const located = findRunState(workspaceRoot, requestedRunId);
    if (!located) {
        throw new Error(`Run not found for id: ${requestedRunId}`);
    }
    const detachedRunId = String(located.state?.detachedRunId || '').trim();
    if (!detachedRunId) {
        throw new Error(`Detached run id is missing in state file for ${requestedRunId}`);
    }

    writeJson(ctrlFilePath(workspaceRoot, detachedRunId), {
        action,
        requestedRunId,
        updatedAt: Date.now()
    });

    const pid = Number(located.state?.pid || 0);
    if (Number.isFinite(pid) && pid > 0) {
        try {
            if (process.platform !== 'win32') {
                process.kill(pid, action === 'pause' ? 'SIGSTOP' : 'SIGCONT');
            }
        } catch {
            // Best effort signal fallback.
        }
    }

    located.state.updatedAt = Date.now();
    located.state.lastControl = action;
    located.state.status = action === 'pause' ? 'paused' : 'running';
    writeJson(located.filePath, located.state);

    process.stdout.write(`${JSON.stringify({ run_id: requestedRunId, detached_run_id: detachedRunId, action }, null, 2)}\n`);
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

function printHelp(): void {
    const lines = [
        'Leion Roots CLI',
        '',
        'Commands:',
        '  create_pipeline --name <name> [--description "..."] [--verbose]',
        '  delete_pipeline --pipeline <path|name> [--verbose]',
        '  edit_pipeline --pipeline <path|name> --yaml <payload|-> [--verbose]',
        '  add_node --pipeline <path|name> --yaml <payload|-> [--verbose]',
        '  delete_node --pipeline <path|name> --node_position <id> [--verbose]',
        '  replace_node --pipeline <path|name> --yaml <payload|-> [--verbose]',
        '  run_pipeline --pipeline <path|name> [--from <node_position>] [--dry_run] [--detached] [--verbose]',
        '  stop_pipeline --run_id <id> [--verbose]',
        '  resume_pipeline --run_id <id> [--verbose]',
        '  route_intent --intent_json <json|@file> [--verbose]',
        '  history_list [--verbose]',
        '  history_show --run_id <id> [--verbose]',
        '  history_clear [--verbose]',
        '  triggers_serve [--verbose]'
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
        printHelp();
        return;
    }

    if (parsed.command === '__worker_run') {
        await runWorker(parsed.flags);
        return;
    }

    const workspaceRoot = getWorkspaceRoot(parsed.flags);

    switch (parsed.command) {
        case 'create_pipeline':
            await handleCreatePipeline(workspaceRoot, parsed.flags);
            return;
        case 'delete_pipeline':
            await handleDeletePipeline(workspaceRoot, parsed.flags);
            return;
        case 'edit_pipeline':
            await handleEditPipeline(workspaceRoot, parsed.flags);
            return;
        case 'add_node':
            await handleAddNode(workspaceRoot, parsed.flags);
            return;
        case 'delete_node':
            await handleDeleteNode(workspaceRoot, parsed.flags);
            return;
        case 'replace_node':
            await handleReplaceNode(workspaceRoot, parsed.flags);
            return;
        case 'run_pipeline':
            await handleRunPipeline(workspaceRoot, parsed.flags);
            return;
        case 'stop_pipeline':
            await writeControlCommand(workspaceRoot, parsed.flags, 'pause');
            return;
        case 'resume_pipeline':
            await writeControlCommand(workspaceRoot, parsed.flags, 'resume');
            return;
        case 'route_intent':
            await handleRouteIntent(workspaceRoot, parsed.flags);
            return;
        case 'history_list':
            await handleHistoryList(workspaceRoot, parsed.flags);
            return;
        case 'history_show':
            await handleHistoryShow(workspaceRoot, parsed.flags);
            return;
        case 'history_clear':
            await handleHistoryClear(workspaceRoot, parsed.flags);
            return;
        case 'triggers_serve':
            await handleTriggersServe(workspaceRoot, parsed.flags);
            return;
        default:
            throw new Error(`Unknown command: ${parsed.command}`);
    }
}

main()
    .then(() => {
        const command = String(process.argv[2] || '').trim();
        if (command !== '__worker_run' && command !== 'triggers_serve') {
            process.exit(process.exitCode ?? 0);
        }
    })
    .catch((error: any) => {
        process.stderr.write(`${String(error?.message || error)}\n`);
        process.exit(1);
    });
