import { builtinCapabilityRegistrations, julesCapabilities } from './builtinCapabilities';
import { policyCapabilities } from './policyCapability';
import { CapabilityArgument } from './types';
import { RUN_LOG_CONTRACT } from './runLogContract';
import { RUN_CONTROL_CONTRACT } from './runControlContract';
import { PIPELINE_INPUT_CONTRACT } from './pipelineSource';
import { isJulesConfigured } from './providers/julesAdapter';

export const PROTOCOL_VERSION = '1';
export const PROTOCOL_COMMANDS = [
    'catalog', 'validate_pipeline', 'run_pipeline', 'route_intent',
    'run_status', 'run_list', 'run_logs',
    'history_list', 'history_show', 'stop_pipeline', 'resume_pipeline', 'cancel_pipeline'
];

export type CatalogArgument = CapabilityArgument & { acceptedTypes?: string[] };
export type CapabilityDescriptor = {
    capability: string;
    provider: string;
    command: string;
    type: string;
    capabilityType: string;
    determinism: string;
    description?: string;
    target?: string;
    args: CatalogArgument[];
    host: string;
    executionMode: string;
    risk: string;
    requirements: string[] | 'unknown';
    available: boolean | 'unknown';
};

// Keep static introspection and registry-oriented consumers on one canonical
// registration set. policyCapabilities lives separately to keep the evaluator
// isolated, but is still a builtin runtime capability.
if (!builtinCapabilityRegistrations.some((registration) =>
    registration.capabilities.some((entry) => typeof entry !== 'string' && entry.capability === 'system.policy.check')
)) {
    builtinCapabilityRegistrations.push(policyCapabilities);
}

// Some legacy builder arguments are labelled "string", while their runtime
// implementations explicitly consume arrays/objects. Preserve that original
// metadata and publish the proven JSON input types used by static validation separately.
const acceptedTypes: Record<string, Record<string, string[]>> = {
    'system.form': { fields: ['array'] },
    'system.switch': { routes: ['array'] },
    'system.loop': { items: ['string', 'array'], graphStepIds: ['array'] },
    'system.policy.check': {
        subject: ['string', 'number', 'boolean', 'object', 'array', 'null'],
        rules: ['array']
    },
    'ai.generate': { contextFiles: ['array'], agentSpecFiles: ['array'] },
    'ai.team': { members: ['array'], contextFiles: ['string', 'array'], agentSpecFiles: ['string', 'array'] },
    'memory.save': { data: ['string', 'number', 'boolean', 'object', 'array', 'null'] },
    'jules.sources.list': { pageSize: ['string', 'number'] },
    'jules.activities.list': { pageSize: ['string', 'number'] }
};

function executionFacts(capability: string): Pick<CapabilityDescriptor, 'host' | 'executionMode' | 'risk' | 'requirements' | 'available'> {
    const unknown = { host: 'cli', executionMode: 'provider', risk: 'unknown', requirements: 'unknown' as const, available: 'unknown' as const };
    if (['system.setVar', 'system.setCwd', 'system.switch'].includes(capability)) {
        return { host: 'cli', executionMode: 'runner', risk: 'none', requirements: [], available: true };
    }
    if (capability === 'system.policy.check') {
        return { host: 'cli', executionMode: 'provider', risk: 'none', requirements: [], available: true };
    }
    if (capability === 'system.form' || capability === 'system.pause') {
        return { host: 'cli', executionMode: capability === 'system.form' ? 'runner' : 'provider', risk: 'human-input', requirements: ['interactive-tty'], available: 'unknown' };
    }
    if (capability === 'git.clone') {
        // Neither the CLI host nor the pipeline compiler implements git.clone.
        return { host: 'vscode', executionMode: 'host-command', risk: 'write', requirements: ['vscode-command-host'], available: false };
    }
    if (capability.startsWith('git.') || capability.startsWith('docker.')) {
        return { host: 'cli', executionMode: 'pipeline-compiled-terminal', risk: 'write', requirements: ['shell', capability.startsWith('git.') ? 'git-executable' : 'docker-executable'], available: 'unknown' };
    }
    if (capability.startsWith('memory.')) {
        return { host: 'cli', executionMode: 'runner', risk: capability === 'memory.recall' ? 'read-only' : 'write', requirements: ['workspace-filesystem'], available: 'unknown' };
    }
    if (capability.startsWith('system.trigger.')) {
        return { ...unknown, executionMode: 'trigger-service', requirements: ['triggers_serve'] };
    }
    if (capability === 'system.subPipeline' || capability === 'system.loop') {
        return { ...unknown, executionMode: capability === 'system.loop' ? 'runner-or-provider' : 'provider', requirements: ['workspace-pipeline-files'] };
    }
    if (capability === 'terminal.run') return { ...unknown, requirements: ['shell'] };
    if (capability === 'http.request') return { ...unknown, risk: 'network', requirements: ['network-access'] };
    if (capability.startsWith('github.')) return { ...unknown, requirements: ['gh-executable', 'github-authentication'] };
    if (capability.startsWith('jules.')) {
        const write = capability === 'jules.session.create' || capability === 'jules.plan.approve';
        return {
            host: 'cli',
            executionMode: 'provider',
            risk: write ? 'network-write' : 'read-only',
            requirements: ['JULES_API_KEY', 'jules-account-access'],
            available: true
        };
    }
    if (capability.startsWith('ai.')) return { ...unknown, requirements: ['configured-ai-cli'] };
    return { ...unknown, host: 'unknown', executionMode: 'unknown' };
}

export function getRuntimeCapabilities(): CapabilityDescriptor[] {
    const descriptors: CapabilityDescriptor[] = [{
        capability: 'pipeline.run', provider: 'runtime', command: 'run_pipeline',
        type: 'unknown', capabilityType: 'composite', determinism: 'unknown', args: [
            { name: 'correlation_id', type: 'string', required: false, description: 'Idempotency key for detached execution' }
        ],
        description: 'Pipeline container and inline composite intent supported by the runner/router',
        host: 'cli', executionMode: 'composite', risk: 'unknown', requirements: [], available: true
    }];
    const registrations = isJulesConfigured()
        ? [...builtinCapabilityRegistrations, julesCapabilities]
        : builtinCapabilityRegistrations;
    for (const registration of registrations) {
        for (const entry of registration.capabilities) {
            if (typeof entry === 'string') continue;
            descriptors.push({
                capability: entry.capability,
                provider: registration.provider || 'unknown',
                command: entry.command,
                type: registration.type || 'unknown',
                capabilityType: entry.capabilityType || 'atomic',
                determinism: entry.determinism || 'unknown',
                ...(entry.description ? { description: entry.description } : {}),
                ...(registration.target ? { target: registration.target } : {}),
                args: (entry.args || []).map((arg) => ({
                    ...arg,
                    ...(acceptedTypes[entry.capability]?.[arg.name]
                        ? { acceptedTypes: acceptedTypes[entry.capability][arg.name] }
                        : {})
                })),
                ...executionFacts(entry.capability)
            });
        }
    }
    // Never expose payload mappers or mutable references to registry metadata.
    return JSON.parse(JSON.stringify(descriptors.sort((a, b) => a.capability.localeCompare(b.capability))));
}

export function describeRuntime(version: string) {
    return {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        runtime: {
            name: 'leion-roots',
            version,
            capabilities: [...PROTOCOL_COMMANDS],
            contracts: {
                pipeline_inputs: PIPELINE_INPUT_CONTRACT,
                run_controls: RUN_CONTROL_CONTRACT,
                run_logs: RUN_LOG_CONTRACT
            }
        },
        capabilities: getRuntimeCapabilities()
    };
}
