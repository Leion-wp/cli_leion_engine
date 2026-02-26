import * as fs from 'fs';
import * as path from 'path';

const yaml = require('js-yaml');

type StartMeta = {
    name?: string;
    description?: string;
};

type CompileResult = {
    start: StartMeta;
    steps: any[];
};

function canonicalizeIntent(providerRaw: any, capabilityRaw: any): string {
    const fallbackProvider = String(providerRaw || '').trim() || 'terminal';
    let capability = String(capabilityRaw || '').trim();
    if (!capability) {
        return `${fallbackProvider}.run`;
    }
    const inferredProvider = capability.includes('.') ? capability.split('.')[0] : fallbackProvider;
    const provider = String(inferredProvider || '').trim() || fallbackProvider;
    if (!capability.includes('.')) {
        capability = `${provider}.${capability}`;
    }
    const duplicatedPrefix = `${provider}.${provider}.`;
    while (capability.startsWith(duplicatedPrefix)) {
        capability = `${provider}.${capability.slice(duplicatedPrefix.length)}`;
    }
    return capability;
}

function readField(node: Record<string, any>, ...keys: string[]): any {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
            return node[key];
        }
    }
    return undefined;
}

function normalizeNodeType(raw: any): string {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function asArray(value: any): any[] {
    if (Array.isArray(value)) {
        return value;
    }
    if (value === undefined || value === null) {
        return [];
    }
    return [value];
}

function parseYamlNodes(yamlText: string): any[] {
    const parsed = yaml.load(String(yamlText || '').trim() || '{}');
    if (!parsed) {
        return [];
    }
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && typeof parsed === 'object') {
        const nodes = (parsed as any).nodes;
        if (Array.isArray(nodes)) {
            return nodes;
        }
        return [parsed];
    }
    throw new Error('Invalid YAML payload: expected object or array.');
}

function removeMetaUi(pipeline: any): void {
    if (!pipeline || typeof pipeline !== 'object') {
        return;
    }
    const meta = pipeline.meta;
    if (!meta || typeof meta !== 'object') {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'ui')) {
        delete meta.ui;
    }
    if (Object.keys(meta).length === 0) {
        delete pipeline.meta;
    }
}

function ensureUniqueStepIds(steps: any[]): void {
    const seen = new Set<string>();
    for (const step of steps) {
        const id = String(step?.id || '').trim();
        if (!id) {
            throw new Error('Each step must have a non-empty id (node_position).');
        }
        if (seen.has(id)) {
            throw new Error(`Duplicate node_position/step.id detected: ${id}`);
        }
        seen.add(id);
    }
}

function parseCsv(value: any): string[] {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function stripControlFields(node: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    const blocked = new Set([
        'type',
        'node_position',
        'nodePosition',
        'id',
        'description',
        'on_failure',
        'onFailure',
        'pipeline_name',
        'pipelineName'
    ]);
    for (const [key, value] of Object.entries(node)) {
        if (blocked.has(key)) {
            continue;
        }
        out[key] = value;
    }
    return out;
}

function compileNode(nodeRaw: any): { start?: StartMeta; step?: any } {
    if (!nodeRaw || typeof nodeRaw !== 'object') {
        throw new Error('Node entry must be an object.');
    }

    const node = nodeRaw as Record<string, any>;
    const type = normalizeNodeType(readField(node, 'type'));

    if (type === 'start' || type === 'start_node') {
        return {
            start: {
                name: String(readField(node, 'pipeline_name', 'pipelineName', 'name') || '').trim() || undefined,
                description: String(readField(node, 'description') || '').trim() || undefined
            }
        };
    }

    const id = String(readField(node, 'node_position', 'nodePosition', 'id') || '').trim();
    if (!id) {
        throw new Error('Node is missing node_position (used as step.id).');
    }
    const description = String(readField(node, 'description') || '').trim() || undefined;
    const onFailure = String(readField(node, 'on_failure', 'onFailure') || '').trim() || undefined;

    let intent = String(readField(node, 'intent') || '').trim();
    let payload: any = readField(node, 'payload');

    if (!intent) {
        if (type === 'prompt' || type === 'prompt_node') {
            intent = 'system.setVar';
            payload = {
                name: String(readField(node, 'name') || '').trim(),
                value: String(readField(node, 'value') ?? '')
            };
        } else if (type === 'form' || type === 'form_node') {
            intent = 'system.form';
            payload = {
                fields: asArray(readField(node, 'fields'))
            };
        } else if (type === 'switch' || type === 'switch_node') {
            intent = 'system.switch';
            payload = {
                variableKey: String(readField(node, 'variable_key', 'variableKey') || '').trim(),
                routes: asArray(readField(node, 'routes')).map((route: any) => ({
                    label: String(route?.label || '').trim(),
                    condition: String(route?.condition || 'equals').trim(),
                    value: String(route?.value ?? route?.equalsValue ?? '').trim(),
                    equalsValue: String(route?.equalsValue ?? route?.value ?? '').trim(),
                    targetStepId: String(route?.target_step_id ?? route?.targetStepId ?? '').trim()
                })),
                defaultStepId: String(readField(node, 'default_step_id', 'defaultStepId', 'default') || '').trim()
            };
        } else if (type === 'repo' || type === 'repo_node') {
            intent = 'system.setCwd';
            payload = {
                path: String(readField(node, 'path') || '').trim()
            };
        } else if (type === 'script' || type === 'script_node') {
            intent = 'terminal.run';
            payload = {
                __kind: 'script',
                scriptPath: String(readField(node, 'script_path', 'scriptPath') || '').trim(),
                args: String(readField(node, 'args') || ''),
                interpreter: String(readField(node, 'interpreter') || '').trim() || undefined,
                cwd: String(readField(node, 'cwd') || '').trim() || undefined
            };
        } else if (type === 'sub_pipeline' || type === 'sub_pipeline_node' || type === 'subpipeline') {
            intent = 'system.subPipeline';
            payload = {
                pipelinePath: String(readField(node, 'pipeline_path', 'pipelinePath') || '').trim(),
                dryRunChild: readField(node, 'dry_run_child', 'dryRunChild') === true,
                inputJson: String(readField(node, 'input_json', 'inputJson') || '').trim() || undefined,
                outputVar: String(readField(node, 'output_var', 'outputVar') || 'subpipeline_result').trim()
            };
        } else if (type === 'loop' || type === 'loop_node') {
            intent = 'system.loop';
            payload = {
                executionMode: String(readField(node, 'execution_mode', 'executionMode') || 'child_pipeline').trim(),
                items: readField(node, 'items'),
                pipelinePath: String(readField(node, 'pipeline_path', 'pipelinePath') || '').trim() || undefined,
                itemVar: String(readField(node, 'item_var', 'itemVar') || 'loop_item').trim(),
                indexVar: String(readField(node, 'index_var', 'indexVar') || 'loop_index').trim(),
                maxIterations: Number(readField(node, 'max_iterations', 'maxIterations') || 20),
                repeatCount: Number(readField(node, 'repeat_count', 'repeatCount') || 1),
                dryRunChild: readField(node, 'dry_run_child', 'dryRunChild') === true,
                continueOnChildError: readField(node, 'continue_on_child_error', 'continueOnChildError') === true,
                errorStrategy: String(readField(node, 'error_strategy', 'errorStrategy') || '').trim() || undefined,
                errorThreshold: Number(readField(node, 'error_threshold', 'errorThreshold') || 1),
                outputVar: String(readField(node, 'output_var', 'outputVar') || 'loop_result').trim(),
                graphStepIds: parseCsv(readField(node, 'graph_step_ids', 'graphStepIds')),
                doneStepId: String(readField(node, 'done_step_id', 'doneStepId') || '').trim() || undefined
            };
        } else if (type === 'agent' || type === 'agent_node') {
            intent = 'ai.generate';
            payload = {
                agent: String(readField(node, 'agent') || 'gemini').trim(),
                model: String(readField(node, 'model') || '').trim() || undefined,
                role: String(readField(node, 'role') || 'architect').trim(),
                reasoningEffort: String(readField(node, 'reasoning_effort', 'reasoningEffort') || 'medium').trim(),
                cwd: String(readField(node, 'cwd') || '').trim() || undefined,
                systemPrompt: String(readField(node, 'system_prompt', 'systemPrompt') || '').trim() || undefined,
                instruction: String(readField(node, 'instruction') || '').trim(),
                instructionTemplate: String(readField(node, 'instruction_template', 'instructionTemplate') || '').trim() || undefined,
                contextFiles: asArray(readField(node, 'context_files', 'contextFiles')),
                agentSpecFiles: asArray(readField(node, 'agent_spec_files', 'agentSpecFiles')),
                outputContract: String(readField(node, 'output_contract', 'outputContract') || 'path_result').trim(),
                outputVar: String(readField(node, 'output_var', 'outputVar') || 'ai_result').trim(),
                outputVarPath: String(readField(node, 'output_var_path', 'outputVarPath') || 'ai_path').trim(),
                outputVarChanges: String(readField(node, 'output_var_changes', 'outputVarChanges') || 'ai_changes').trim(),
                sessionId: String(readField(node, 'session_id', 'sessionId') || '').trim() || undefined,
                sessionMode: String(readField(node, 'session_mode', 'sessionMode') || 'read_write').trim(),
                sessionResetBeforeRun: readField(node, 'session_reset_before_run', 'sessionResetBeforeRun') === true,
                sessionRecallLimit: Number(readField(node, 'session_recall_limit', 'sessionRecallLimit') || 12)
            };
        } else if (type === 'team' || type === 'team_node') {
            intent = 'ai.team';
            payload = {
                strategy: String(readField(node, 'strategy') || 'sequential').trim(),
                cwd: String(readField(node, 'cwd') || '').trim() || undefined,
                systemPrompt: String(readField(node, 'system_prompt', 'systemPrompt') || '').trim() || undefined,
                members: asArray(readField(node, 'members')),
                contextFiles: asArray(readField(node, 'context_files', 'contextFiles')),
                agentSpecFiles: asArray(readField(node, 'agent_spec_files', 'agentSpecFiles')),
                outputContract: String(readField(node, 'output_contract', 'outputContract') || 'path_result').trim(),
                outputVar: String(readField(node, 'output_var', 'outputVar') || 'team_result').trim(),
                outputVarPath: String(readField(node, 'output_var_path', 'outputVarPath') || 'team_path').trim(),
                outputVarChanges: String(readField(node, 'output_var_changes', 'outputVarChanges') || 'team_changes').trim(),
                reviewerVoteWeight: Number(readField(node, 'reviewer_vote_weight', 'reviewerVoteWeight') || 2),
                sessionId: String(readField(node, 'session_id', 'sessionId') || '').trim() || undefined,
                sessionMode: String(readField(node, 'session_mode', 'sessionMode') || 'read_write').trim(),
                sessionResetBeforeRun: readField(node, 'session_reset_before_run', 'sessionResetBeforeRun') === true,
                sessionRecallLimit: Number(readField(node, 'session_recall_limit', 'sessionRecallLimit') || 12)
            };
        } else if (type === 'http' || type === 'http_request' || type === 'http_node') {
            intent = 'http.request';
            payload = {
                url: String(readField(node, 'url') || '').trim(),
                method: String(readField(node, 'request', 'method') || 'GET').trim().toUpperCase(),
                headers: readField(node, 'headers') ?? '{}',
                body: readField(node, 'body') ?? '',
                outputVar: String(readField(node, 'output_var', 'outputVar') || '').trim() || undefined
            };
        } else if (type === 'action' || type === 'action_node') {
            intent = canonicalizeIntent(readField(node, 'provider'), readField(node, 'capability', 'intent'));
            payload = readField(node, 'args') ?? readField(node, 'payload') ?? stripControlFields(node);
        } else {
            const fallbackIntent = String(readField(node, 'intent') || '').trim();
            if (!fallbackIntent) {
                throw new Error(`Unsupported node type: ${type || '(empty)'}`);
            }
            intent = fallbackIntent;
            payload = readField(node, 'payload') ?? stripControlFields(node);
        }
    }

    if (!intent) {
        throw new Error(`Unable to resolve intent for node_position ${id}`);
    }
    if (String(intent).toLowerCase().startsWith('vscode.')) {
        throw new Error(`vscode.* intents are blocked in CLI DSL: ${intent}`);
    }

    const step: any = {
        id,
        intent,
        ...(description ? { description } : {}),
        payload: payload ?? {}
    };
    if (onFailure) {
        step.onFailure = onFailure;
    }

    return { step };
}

function compileNodes(nodes: any[]): CompileResult {
    const start: StartMeta = {};
    const steps: any[] = [];

    for (const node of nodes) {
        const compiled = compileNode(node);
        if (compiled.start) {
            if (compiled.start.name) {
                start.name = compiled.start.name;
            }
            if (compiled.start.description !== undefined) {
                start.description = compiled.start.description;
            }
            continue;
        }
        if (compiled.step) {
            steps.push(compiled.step);
        }
    }

    ensureUniqueStepIds(steps);
    return { start, steps };
}

function hasReferences(steps: any[], targetId: string): string[] {
    const references: string[] = [];
    for (const step of steps) {
        const sourceId = String(step?.id || 'unknown');
        if (String(step?.onFailure || '') === targetId) {
            references.push(`${sourceId}.onFailure`);
        }
        if (String(step?.intent || '') === 'system.switch') {
            const defaultStepId = String(step?.payload?.defaultStepId || '').trim();
            if (defaultStepId === targetId) {
                references.push(`${sourceId}.payload.defaultStepId`);
            }
            const routes = Array.isArray(step?.payload?.routes) ? step.payload.routes : [];
            for (let index = 0; index < routes.length; index += 1) {
                const route = routes[index];
                if (String(route?.targetStepId || '').trim() === targetId) {
                    references.push(`${sourceId}.payload.routes[${index}].targetStepId`);
                }
            }
        }
        if (String(step?.intent || '') === 'system.loop') {
            const graphStepIds = Array.isArray(step?.payload?.graphStepIds) ? step.payload.graphStepIds : [];
            if (graphStepIds.map((entry: any) => String(entry || '').trim()).includes(targetId)) {
                references.push(`${sourceId}.payload.graphStepIds`);
            }
            if (String(step?.payload?.doneStepId || '').trim() === targetId) {
                references.push(`${sourceId}.payload.doneStepId`);
            }
        }
    }
    return references;
}

export class DslMutationService {
    constructor(private readonly workspaceRoot: string) {}

    private resolvePipelinePath(pipelineRef: string): string {
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
            return path.resolve(this.workspaceRoot, withExt);
        }
        return path.resolve(this.workspaceRoot, 'pipeline', withExt);
    }

    private readPipeline(filePath: string): any {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Pipeline not found: ${filePath}`);
        }
        const text = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.steps)) {
            throw new Error(`Invalid pipeline JSON: ${filePath}`);
        }
        return parsed;
    }

    private writePipeline(filePath: string, pipeline: any): void {
        removeMetaUi(pipeline);
        ensureUniqueStepIds(Array.isArray(pipeline.steps) ? pipeline.steps : []);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
    }

    private compileYamlPayload(yamlPayload: string): CompileResult {
        const nodes = parseYamlNodes(yamlPayload);
        if (!nodes.length) {
            throw new Error('YAML payload does not contain any node.');
        }
        return compileNodes(nodes);
    }

    create_pipeline(name: string, description?: string): { path: string; pipeline: any } {
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            throw new Error('Pipeline name is required.');
        }
        const filePath = this.resolvePipelinePath(trimmed);
        if (fs.existsSync(filePath)) {
            throw new Error(`Pipeline already exists: ${filePath}`);
        }
        const pipeline = {
            name: trimmed.replace(/\.intent\.json$/i, ''),
            ...(String(description || '').trim() ? { description: String(description).trim() } : {}),
            steps: [] as any[]
        };
        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline };
    }

    delete_pipeline(pipelineRef: string): { path: string } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Pipeline not found: ${filePath}`);
        }
        fs.unlinkSync(filePath);
        return { path: filePath };
    }

    edit_pipeline(pipelineRef: string, yamlPayload: string): { path: string; pipeline: any } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        const current = this.readPipeline(filePath);
        const compiled = this.compileYamlPayload(yamlPayload);
        const pipeline = {
            ...current,
            ...(compiled.start.name ? { name: compiled.start.name } : {}),
            ...(compiled.start.description !== undefined ? { description: compiled.start.description } : {}),
            steps: compiled.steps
        };
        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline };
    }

    add_node(pipelineRef: string, yamlPayload: string): { path: string; pipeline: any; added: number } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        const pipeline = this.readPipeline(filePath);
        const compiled = this.compileYamlPayload(yamlPayload);

        if (compiled.start.name) {
            pipeline.name = compiled.start.name;
        }
        if (compiled.start.description !== undefined) {
            pipeline.description = compiled.start.description;
        }

        const existingIds = new Set((pipeline.steps || []).map((step: any) => String(step?.id || '').trim()));
        for (const step of compiled.steps) {
            const id = String(step?.id || '').trim();
            if (existingIds.has(id)) {
                throw new Error(`Cannot add node_position "${id}": already exists.`);
            }
            existingIds.add(id);
            pipeline.steps.push(step);
        }

        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline, added: compiled.steps.length };
    }

    replace_node(pipelineRef: string, yamlPayload: string): { path: string; pipeline: any } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        const pipeline = this.readPipeline(filePath);
        const compiled = this.compileYamlPayload(yamlPayload);

        if (compiled.start.name) {
            pipeline.name = compiled.start.name;
        }
        if (compiled.start.description !== undefined) {
            pipeline.description = compiled.start.description;
        }

        if (compiled.steps.length !== 1) {
            throw new Error('replace_node expects exactly one executable node in YAML payload.');
        }

        const replacement = compiled.steps[0];
        const targetId = String(replacement?.id || '').trim();
        const index = pipeline.steps.findIndex((step: any) => String(step?.id || '').trim() === targetId);
        if (index === -1) {
            throw new Error(`Cannot replace node_position "${targetId}": not found.`);
        }
        pipeline.steps[index] = replacement;

        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline };
    }

    delete_node(pipelineRef: string, nodePosition: string): { path: string; pipeline: any; removed: string } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        const pipeline = this.readPipeline(filePath);
        const targetId = String(nodePosition || '').trim();
        if (!targetId) {
            throw new Error('node_position is required.');
        }

        const index = pipeline.steps.findIndex((step: any) => String(step?.id || '').trim() === targetId);
        if (index === -1) {
            throw new Error(`Node not found: ${targetId}`);
        }

        const otherSteps = pipeline.steps.filter((step: any, stepIndex: number) => stepIndex !== index);
        const references = hasReferences(otherSteps, targetId);
        if (references.length > 0) {
            throw new Error(`Cannot delete node_position "${targetId}": still referenced by ${references.join(', ')}`);
        }

        pipeline.steps.splice(index, 1);
        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline, removed: targetId };
    }

    reorder_nodes(pipelineRef: string, orderedNodePositions: string[]): { path: string; pipeline: any } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        const pipeline = this.readPipeline(filePath);
        const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
        const normalized = Array.isArray(orderedNodePositions)
            ? orderedNodePositions.map((entry) => String(entry || '').trim()).filter(Boolean)
            : [];
        if (!normalized.length) {
            throw new Error('orderedNodePositions must contain at least one node_position.');
        }

        const existingIds = steps.map((step: any) => String(step?.id || '').trim());
        const existingSet = new Set(existingIds);
        const orderSet = new Set(normalized);
        if (orderSet.size !== normalized.length) {
            throw new Error('orderedNodePositions contains duplicates.');
        }
        if (normalized.length !== existingIds.length) {
            throw new Error(`orderedNodePositions length mismatch: expected ${existingIds.length}, got ${normalized.length}.`);
        }
        for (const id of normalized) {
            if (!existingSet.has(id)) {
                throw new Error(`orderedNodePositions contains unknown id: ${id}`);
            }
        }

        const byId = new Map<string, any>();
        for (const step of steps) {
            byId.set(String(step?.id || '').trim(), step);
        }
        pipeline.steps = normalized.map((id) => byId.get(id));
        this.writePipeline(filePath, pipeline);
        return { path: filePath, pipeline };
    }
}
