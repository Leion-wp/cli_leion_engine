import * as fs from 'fs';
import * as path from 'path';
import { CapabilityDescriptor, getRuntimeCapabilities, PROTOCOL_VERSION } from './runtimeCatalog';

export type ValidationDiagnostic = {
    code: string;
    severity: 'error' | 'warning';
    message: string;
    path: string;
    file?: string;
    stepId?: string;
};

export type PipelineValidation = {
    ok: boolean;
    protocolVersion: string;
    valid: boolean;
    path?: string;
    name?: string;
    steps?: number;
    diagnostics: ValidationDiagnostic[];
};

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const pointerKey = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const valueType = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const dynamic = (value: unknown) => typeof value === 'string' && /\$\{[^}]+\}/.test(value);

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

class ValidationPathError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

export function resolveValidationPath(workspace: string, reference: string): string {
    const root = path.resolve(workspace);
    if (!reference || !reference.trim()) throw new ValidationPathError('PIPELINE_REQUIRED', 'A pipeline name or path is required.');
    if (reference.includes('\0')) throw new ValidationPathError('INVALID_PATH', 'Pipeline paths cannot contain NUL.');
    if (process.platform !== 'win32' && path.win32.isAbsolute(reference) && !path.isAbsolute(reference)) {
        throw new ValidationPathError('PATH_OUTSIDE_PIPELINE', 'A foreign absolute path is outside the workspace pipeline directory.');
    }
    const ref = reference.replace(/[\\/]/g, path.sep);
    const withExtension = ref.endsWith('.intent.json') ? ref : `${ref}.intent.json`;
    const pipelineRoot = path.join(root, 'pipeline');
    const candidate = path.isAbsolute(withExtension)
        ? path.resolve(withExtension)
        : path.resolve(withExtension.includes(path.sep) ? root : pipelineRoot, withExtension);
    if (!inside(pipelineRoot, candidate)) throw new ValidationPathError('PATH_OUTSIDE_PIPELINE', 'Pipeline files must stay under <workspace>/pipeline.');
    const realRoot = fs.realpathSync(root);
    const realPipelineRoot = fs.realpathSync(pipelineRoot);
    if (!inside(realRoot, realPipelineRoot)) throw new ValidationPathError('PATH_OUTSIDE_WORKSPACE', 'The pipeline directory resolves outside the workspace.');
    const realCandidate = fs.realpathSync(candidate);
    if (!inside(realPipelineRoot, realCandidate)) throw new ValidationPathError('PATH_OUTSIDE_PIPELINE', 'The pipeline file resolves outside the pipeline directory.');
    if (!fs.statSync(realCandidate).isFile()) throw new ValidationPathError('NOT_A_FILE', 'The pipeline path must identify a regular file.');
    return realCandidate;
}

export function validatePipelineData(input: unknown, catalog: CapabilityDescriptor[] = getRuntimeCapabilities()): PipelineValidation {
    const diagnostics: ValidationDiagnostic[] = [];
    const capabilities = new Map(catalog.map((entry) => [entry.capability, entry]));
    const allIds = new Set<string>();
    const report = (code: string, location: string, message: string, stepId?: string, severity: 'error' | 'warning' = 'error') => {
        diagnostics.push({ code, path: location, message, severity, ...(stepId ? { stepId } : {}) });
    };

    function checkSteps(rawSteps: unknown, location: string, depth = 0): void {
        if (depth > 32) { report('MAX_DEPTH', location, 'Inline composites exceed the static validation depth limit (32).'); return; }
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
            report('INVALID_STEPS', location, 'steps must be a non-empty array.');
            return;
        }
        const ids = new Set(rawSteps.filter(object).map((step) => step.id).filter((id) => typeof id === 'string' && id.trim()));
        const checkTarget = (value: unknown, targetPath: string, stepId?: string) => {
            if (typeof value !== 'string' || !value.trim()) report('INVALID_TARGET', targetPath, 'A target must be a non-empty step id.', stepId);
            else if (!ids.has(value)) report('UNKNOWN_TARGET', targetPath, `Target step "${value}" does not exist in this steps array.`, stepId);
        };
        rawSteps.forEach((step, index) => {
            const stepPath = `${location}/${index}`;
            if (!object(step)) { report('INVALID_STEP', stepPath, 'Each step must be an object.'); return; }
            const id = typeof step.id === 'string' && step.id.trim() ? step.id : undefined;
            if (!id) report('INVALID_STEP_ID', `${stepPath}/id`, 'Each step requires a non-empty string id.');
            else if (allIds.has(id)) report('DUPLICATE_STEP_ID', `${stepPath}/id`, `Duplicate step id "${id}".`, id);
            else allIds.add(id);
            const intent = typeof step.intent === 'string' ? step.intent : '';
            const descriptor = capabilities.get(intent);
            if (!intent.trim()) report('INVALID_INTENT', `${stepPath}/intent`, 'Each step requires a non-empty intent.', id);
            else if (!descriptor) report('UNKNOWN_INTENT', `${stepPath}/intent`, `Intent "${intent}" is not in the canonical runtime catalog.`, id);
            else if (descriptor.available === false) report('UNAVAILABLE_INTENT', `${stepPath}/intent`, `Intent "${intent}" is not executable in the CLI host.`, id);
            if (step.capabilities !== undefined) {
                if (!Array.isArray(step.capabilities) || !step.capabilities.length) report('INVALID_CAPABILITIES', `${stepPath}/capabilities`, 'capabilities must be a non-empty array.', id);
                else step.capabilities.forEach((name: unknown, capabilityIndex: number) => {
                    const entry = typeof name === 'string' ? capabilities.get(name) : undefined;
                    if (!entry) report('UNKNOWN_INTENT', `${stepPath}/capabilities/${capabilityIndex}`, 'Capability overrides must be members of the canonical catalog.', id);
                    else if (entry.available === false) report('UNAVAILABLE_INTENT', `${stepPath}/capabilities/${capabilityIndex}`, `Capability "${name}" is not executable in the CLI host.`, id);
                });
            }
            if (step.payload !== undefined && !object(step.payload)) report('INVALID_PAYLOAD', `${stepPath}/payload`, 'payload must be an object.', id);
            const payload = object(step.payload) ? step.payload : {};
            const graphLoop = intent === 'system.loop' && payload.executionMode === 'graph_segment';
            const argumentDescriptors = new Map<string, CapabilityDescriptor>();
            if (descriptor) argumentDescriptors.set(descriptor.capability, descriptor);
            for (const name of Array.isArray(step.capabilities) ? step.capabilities : []) {
                const override = capabilities.get(name);
                if (override) argumentDescriptors.set(override.capability, override);
            }
            for (const argumentDescriptor of argumentDescriptors.values()) for (const arg of argumentDescriptor.args) {
                if (graphLoop && argumentDescriptor.capability === 'system.loop' && arg.name === 'pipelinePath') continue;
                const value = payload[arg.name];
                const argPath = `${stepPath}/payload/${pointerKey(arg.name)}`;
                if (arg.required && (value === undefined || value === null || value === '')) report('REQUIRED_ARGUMENT', argPath, `Required argument "${arg.name}" is missing.`, id);
                if (value === undefined) continue;
                if (dynamic(value)) {
                    report('DYNAMIC_ARGUMENT', argPath, 'The argument contains a runtime template; its resolved type/value is not statically verified.', id, 'warning');
                    continue;
                }
                const expected = arg.acceptedTypes || [arg.type === 'path' || arg.type === 'enum' ? 'string' : arg.type];
                if (!expected.includes(valueType(value))) report('ARGUMENT_TYPE', argPath, `Argument "${arg.name}" must have JSON type ${expected.join(' or ')}.`, id);
                else if (arg.type === 'enum' && Array.isArray(arg.options) && !arg.options.includes(value)) report('ARGUMENT_ENUM', argPath, `Argument "${arg.name}" must match a declared option.`, id);
            }
            if (step.onFailure !== undefined) checkTarget(step.onFailure, `${stepPath}/onFailure`, id);
            for (const key of ['defaultStepId', 'doneStepId']) {
                if (payload[key] !== undefined) checkTarget(payload[key], `${stepPath}/payload/${key}`, id);
            }
            if (payload.routes !== undefined) {
                if (!Array.isArray(payload.routes)) report('INVALID_ROUTES', `${stepPath}/payload/routes`, 'routes must be an array.', id);
                else payload.routes.forEach((route: unknown, routeIndex: number) => {
                    const routePath = `${stepPath}/payload/routes/${routeIndex}`;
                    if (!object(route)) report('INVALID_ROUTE', routePath, 'Each route must be an object.', id);
                    else checkTarget(route.targetStepId, `${routePath}/targetStepId`, id);
                });
            }
            if (payload.graphStepIds !== undefined || graphLoop) {
                if (!Array.isArray(payload.graphStepIds) || !payload.graphStepIds.length) report('INVALID_GRAPH_STEPS', `${stepPath}/payload/graphStepIds`, 'graphStepIds must be a non-empty array.', id);
                else payload.graphStepIds.forEach((target: unknown, targetIndex: number) => {
                    checkTarget(target, `${stepPath}/payload/graphStepIds/${targetIndex}`, id);
                    if (target === id) report('LOOP_SELF_REFERENCE', `${stepPath}/payload/graphStepIds/${targetIndex}`, 'A graph loop cannot include its own step id.', id);
                });
            }
            if (step.steps !== undefined) checkSteps(step.steps, `${stepPath}/steps`, depth + 1);
            else if (intent === 'pipeline.run') report('INVALID_STEPS', `${stepPath}/steps`, 'A composite pipeline.run requires child steps.', id);
            if (intent === 'system.subPipeline' || (intent === 'system.loop' && !graphLoop)) {
                report('CHILD_NOT_VALIDATED', `${stepPath}/payload/pipelinePath`, 'Child pipeline files are not read recursively; validate each child separately.', id, 'warning');
            }
        });
    }

    if (!object(input)) report('INVALID_PIPELINE', '', 'The pipeline must be a JSON object.');
    else {
        if (typeof input.name !== 'string' || !input.name.trim()) report('INVALID_NAME', '/name', 'The pipeline requires a non-empty name.');
        if (input.intent !== undefined && input.intent !== 'pipeline.run') report('INVALID_ROOT_INTENT', '/intent', 'The root intent, when provided, must be pipeline.run.');
        checkSteps(input.steps, '/steps');
    }
    const valid = !diagnostics.some((entry) => entry.severity === 'error');
    return {
        ok: valid, protocolVersion: PROTOCOL_VERSION, valid,
        ...(object(input) && typeof input.name === 'string' ? { name: input.name } : {}),
        ...(object(input) && Array.isArray(input.steps) ? { steps: input.steps.length } : {}),
        diagnostics
    };
}

export function validatePipelineFile(workspace: string, reference: string): PipelineValidation {
    let file: string | undefined;
    try {
        file = resolveValidationPath(workspace, reference);
        let input: unknown;
        try { input = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) {
            return { ok: false, protocolVersion: PROTOCOL_VERSION, valid: false, path: file, diagnostics: [{
                code: error instanceof SyntaxError ? 'INVALID_JSON' : 'READ_FAILED', severity: 'error', path: '', file,
                message: error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : 'Unable to read the pipeline file.'
            }] };
        }
        const result = validatePipelineData(input);
        return { ...result, path: file, diagnostics: result.diagnostics.map((entry) => ({ ...entry, file })) };
    } catch (error: any) {
        return { ok: false, protocolVersion: PROTOCOL_VERSION, valid: false, diagnostics: [{
            code: error instanceof ValidationPathError ? error.code : 'PATH_UNAVAILABLE', severity: 'error', path: '',
            message: error instanceof ValidationPathError ? error.message : 'The workspace, pipeline directory, or file is unavailable.'
        }] };
    }
}
