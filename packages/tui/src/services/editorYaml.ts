import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const NODE_TEMPLATE_KEYS = [
    'action',
    'script',
    'http',
    'prompt',
    'form',
    'switch',
    'repo',
    'sub_pipeline',
    'loop',
    'agent',
    'team',
    'memory_save',
    'memory_recall',
    'memory_clear'
] as const;

export type NodeTemplateKey = typeof NODE_TEMPLATE_KEYS[number];

export const NODE_TEMPLATE_HINT = NODE_TEMPLATE_KEYS.join('|');

function escapeYamlSingleQuoted(value: string): string {
    return String(value || '').replace(/'/g, "''");
}

export function generatePipelineName(): string {
    return `pipeline_${Date.now().toString(36).slice(-8)}`;
}

export function normalizeNodeTemplateKey(input: string): NodeTemplateKey | undefined {
    const raw = String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[.\s-]+/g, '_');
    const aliases: Record<string, NodeTemplateKey> = {
        action: 'action',
        script: 'script',
        http: 'http',
        http_request: 'http',
        prompt: 'prompt',
        form: 'form',
        switch: 'switch',
        repo: 'repo',
        sub_pipeline: 'sub_pipeline',
        subpipeline: 'sub_pipeline',
        loop: 'loop',
        agent: 'agent',
        team: 'team',
        memory_save: 'memory_save',
        memory_recall: 'memory_recall',
        memory_clear: 'memory_clear',
        memorysave: 'memory_save',
        memoryrecall: 'memory_recall',
        memoryclear: 'memory_clear'
    };
    return aliases[raw];
}

export function buildActionNodeYaml(step: any, patch?: {
    intent?: string;
    description?: string;
    onFailure?: string;
    payload?: any;
}): string {
    const id = String(step?.id || '').trim();
    const intent = String(patch?.intent ?? step?.intent ?? '').trim();
    const description = patch?.description ?? step?.description;
    const onFailure = patch?.onFailure ?? step?.onFailure;
    const payload = patch?.payload ?? step?.payload ?? {};
    const lines: string[] = [];
    lines.push('type: action');
    lines.push(`node_position: '${escapeYamlSingleQuoted(id)}'`);
    lines.push(`intent: '${escapeYamlSingleQuoted(intent)}'`);
    if (String(description || '').trim()) {
        lines.push(`description: '${escapeYamlSingleQuoted(String(description).trim())}'`);
    }
    if (String(onFailure || '').trim()) {
        lines.push(`on_failure: '${escapeYamlSingleQuoted(String(onFailure).trim())}'`);
    }
    lines.push('payload:');
    lines.push(`  ${JSON.stringify(payload)}`);
    return lines.join('\n');
}

export function buildPipelineYaml(pipeline: any): string {
    const pipelineName = String(pipeline?.name || '').trim();
    const pipelineDescription = String(pipeline?.description || '').trim();
    const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
    const lines: string[] = [];
    lines.push('nodes:');
    lines.push('  - type: start');
    if (pipelineName) {
        lines.push(`    pipeline_name: '${escapeYamlSingleQuoted(pipelineName)}'`);
    }
    if (pipelineDescription) {
        lines.push(`    description: '${escapeYamlSingleQuoted(pipelineDescription)}'`);
    }
    for (const step of steps) {
        const nodeYaml = buildActionNodeYaml(step)
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n');
        lines.push('  -');
        lines.push(nodeYaml);
    }
    return lines.join('\n');
}

export function buildAddNodeTemplate(nodeType: NodeTemplateKey, nextId: string): string {
    if (nodeType === 'action') {
        return [
            'type: action',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Run shell command'`,
            `intent: 'terminal.run'`,
            'payload:',
            `  {"command":"echo ${nextId}"}`
        ].join('\n');
    }
    if (nodeType === 'script') {
        return [
            'type: script',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Run local script'`,
            `script_path: './scripts/task.sh'`,
            `args: ''`,
            `interpreter: 'bash'`,
            `cwd: '.'`
        ].join('\n');
    }
    if (nodeType === 'http') {
        return [
            'type: http',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'HTTP request'`,
            `url: 'https://example.com'`,
            `method: 'GET'`,
            `headers: {}`,
            `body: ''`,
            `output_var: 'http_result'`
        ].join('\n');
    }
    if (nodeType === 'prompt') {
        return [
            'type: prompt',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Set variable from prompt'`,
            `name: 'input_value'`,
            `value: ''`
        ].join('\n');
    }
    if (nodeType === 'form') {
        return [
            'type: form',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Collect variables from form'`,
            `fields:`,
            `  - key: branch`,
            `    label: Branch`,
            `    type: text`,
            `    required: true`
        ].join('\n');
    }
    if (nodeType === 'switch') {
        return [
            'type: switch',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Conditional route'`,
            `variable_key: 'route_key'`,
            `default_step_id: ''`,
            `routes:`,
            `  - label: main`,
            `    condition: equals`,
            `    value: main`,
            `    target_step_id: ''`
        ].join('\n');
    }
    if (nodeType === 'repo') {
        return [
            'type: repo',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Set runtime working directory'`,
            `path: '.'`
        ].join('\n');
    }
    if (nodeType === 'sub_pipeline') {
        return [
            'type: sub_pipeline',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Run child pipeline'`,
            `pipeline_path: './pipeline/child.intent.json'`,
            `dry_run_child: false`,
            `output_var: 'subpipeline_result'`
        ].join('\n');
    }
    if (nodeType === 'loop') {
        return [
            'type: loop',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Loop over items'`,
            `execution_mode: 'child_pipeline'`,
            `items: ['one', 'two']`,
            `pipeline_path: './pipeline/child.intent.json'`,
            `item_var: 'loop_item'`,
            `index_var: 'loop_index'`
        ].join('\n');
    }
    if (nodeType === 'agent') {
        return [
            'type: agent',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Single AI agent step'`,
            `agent: 'gemini'`,
            `role: 'architect'`,
            `reasoning_effort: 'medium'`,
            `instruction: 'Analyze and propose changes'`,
            `output_var: 'ai_result'`
        ].join('\n');
    }
    if (nodeType === 'team') {
        return [
            'type: team',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Multi-agent team step'`,
            `strategy: 'sequential'`,
            `members: []`,
            `output_var: 'team_result'`
        ].join('\n');
    }
    if (nodeType === 'memory_save') {
        return [
            'type: action',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Memory save'`,
            `intent: 'memory.save'`,
            'payload:',
            `  {"sessionId":"default","key":"note","value":"hello","outputVar":"memory_saved_id"}`
        ].join('\n');
    }
    if (nodeType === 'memory_recall') {
        return [
            'type: action',
            `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
            `description: 'Memory recall'`,
            `intent: 'memory.recall'`,
            'payload:',
            `  {"sessionId":"default","key":"note","limit":"5","outputVar":"memory_recall"}`
        ].join('\n');
    }
    return [
        'type: action',
        `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
        `description: 'Memory clear'`,
        `intent: 'memory.clear'`,
        'payload:',
        `  {"sessionId":"default","key":"note","keepLast":"0","outputVarRemoved":"memory_removed"}`
    ].join('\n');
}

export function resolveEditorCommand(): string {
    const explicit = String(process.env.LEION_TUI_EDITOR || '').trim();
    if (explicit) {
        return explicit;
    }
    return 'nano';
}

export function editTextWithEditor(initialText: string): { ok: boolean; text?: string; error?: string } {
    const tempFile = path.join(os.tmpdir(), `leion-node-${Date.now().toString(36)}.yaml`);
    const decorated = [
        '# Leion TUI YAML Editor',
        '# Save + quit to apply. Leave node_position unchanged.',
        '',
        initialText
    ].join('\n');
    fs.writeFileSync(tempFile, `${decorated}\n`, 'utf8');
    const editor = resolveEditorCommand();
    const quotedPath = tempFile.replace(/'/g, "'\\''");
    const command = `${editor} '${quotedPath}'`;
    const result = cp.spawnSync('/bin/sh', ['-lc', command], {
        stdio: 'inherit'
    });
    if (result.status !== 0) {
        return { ok: false, error: `Editor exited with status ${String(result.status)}` };
    }
    try {
        const text = fs.readFileSync(tempFile, 'utf8');
        return { ok: true, text };
    } catch (error: any) {
        return { ok: false, error: String(error?.message || error) };
    } finally {
        try {
            fs.unlinkSync(tempFile);
        } catch {
            // noop
        }
    }
}
