import { RegisterCapabilitiesArgs } from './types';

// Shared declarations: registration and read-only introspection consume the same metadata.
export const gitCapabilities: RegisterCapabilitiesArgs = {
        provider: 'git',
        type: 'vscode',
        capabilities: [
            {
                capability: 'git.clone',
                command: 'git.clone',
                description: 'Clone a repository',
                determinism: 'deterministic',
                args: [
                    { name: 'url', type: 'string', description: 'Repository URL', required: true },
                    { name: 'dir', type: 'path', description: 'Target directory (optional)' }
                ]
            },
            {
                capability: 'git.commit',
                command: 'git.commit',
                description: 'Commit changes to the local repository',
                determinism: 'deterministic',
                args: [
                    { name: 'message', type: 'string', description: 'Commit message', required: true },
                    { name: 'amend', type: 'boolean', description: 'Amend previous commit', default: false }
                ],
                mapPayload: (intent) => intent.payload?.message ? { message: intent.payload.message } : undefined
            },
            {
                capability: 'git.push',
                command: 'git.push',
                description: 'Push changes to remote repository',
                determinism: 'deterministic',
                args: [
                    // git.push in VS Code usually doesn't take arguments via command, but we can support remote/branch later
                ]
            },
            {
                capability: 'git.pull',
                command: 'git.pull',
                description: 'Pull changes from remote repository',
                determinism: 'deterministic',
                args: []
            },
            {
                capability: 'git.checkout',
                command: 'git.checkout',
                description: 'Checkout a branch or tag',
                determinism: 'deterministic',
                args: [
                     { name: 'branch', type: 'string', description: 'Branch name to checkout', required: true },
                     { name: 'create', type: 'boolean', description: 'Create new branch', default: false }
                ]
            }
        ]
    };

export const dockerCapabilities: RegisterCapabilitiesArgs = {
        provider: 'docker',
        type: 'vscode',
        capabilities: [
            {
                capability: 'docker.build',
                command: 'vscode-docker.configure', // Best approximation for build workflow in V1
                description: 'Build a Docker image',
                determinism: 'deterministic',
                args: [
                    { name: 'tag', type: 'string', description: 'Image tag', required: true },
                    { name: 'path', type: 'path', description: 'Context path', default: '.' }
                ]
            },
            {
                capability: 'docker.run',
                command: 'vscode-docker.containers.start',
                description: 'Run a Docker container',
                determinism: 'deterministic',
                args: [
                    { name: 'image', type: 'string', description: 'Image ID or name', required: true },
                    { name: 'detach', type: 'boolean', description: 'Run in background', default: true }
                ]
            }
        ]
    };

export const terminalCapabilities: RegisterCapabilitiesArgs = {
        provider: 'terminal',
        type: 'vscode',
        capabilities: [
            {
                capability: 'terminal.run',
                command: 'intentRouter.internal.terminalRun',
                description: 'Run a shell command in the integrated terminal',
                determinism: 'deterministic',
                args: [
                    { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
                    { name: 'cwd', type: 'path', description: 'Working directory', default: '.' }
                ]
            }
        ]
    };

export const systemCapabilities: RegisterCapabilitiesArgs = {
        provider: 'system',
        type: 'vscode',
        capabilities: [
            {
                capability: 'system.pause',
                command: 'intentRouter.internal.systemPause',
                description: 'Pause execution for human verification',
                determinism: 'interactive',
                args: [
                    { name: 'message', type: 'string', description: 'Message to display in the modal', required: true, default: 'Pipeline paused for review.' }
                ]
            },
            {
                capability: 'system.setVar',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Set a pipeline variable for later steps',
                determinism: 'deterministic',
                args: [
                    { name: 'name', type: 'string', description: 'Variable name (used by ${input:Name} / ${var:Name})', required: true },
                    { name: 'value', type: 'string', description: 'Variable value', required: true }
                ]
            },
            {
                capability: 'system.setCwd',
                command: 'intentRouter.internal.systemSetCwd',
                description: 'Set the working directory for subsequent steps',
                determinism: 'deterministic',
                args: [
                    { name: 'path', type: 'path', description: 'Working directory path', required: true }
                ]
            },
            {
                capability: 'system.form',
                command: 'intentRouter.internal.systemForm',
                description: 'Collect human inputs and store them as variables',
                determinism: 'interactive',
                args: [
                    { name: 'fields', type: 'string', description: 'JSON array of fields (handled by runner)', required: false }
                ]
            },
            {
                capability: 'system.switch',
                command: 'intentRouter.internal.systemSwitch',
                description: 'Route to a branch based on a variable value (equals match + default)',
                determinism: 'deterministic',
                args: [
                    { name: 'variableKey', type: 'string', description: 'Variable key to read', required: true },
                    { name: 'routes', type: 'string', description: 'JSON routes (handled by runner)', required: false },
                    { name: 'defaultStepId', type: 'string', description: 'Default target step id', required: true }
                ]
            },
            {
                capability: 'system.subPipeline',
                command: 'intentRouter.internal.systemSubPipeline',
                description: 'Run another pipeline file as a nested sub-run',
                determinism: 'deterministic',
                args: [
                    { name: 'pipelinePath', type: 'path', description: 'Child pipeline path (.intent.json)', required: true },
                    { name: 'dryRunChild', type: 'boolean', description: 'Run child in dry-run mode', required: false, default: false },
                    { name: 'inputJson', type: 'string', description: 'Optional input JSON object for child runtime variables', required: false },
                    { name: 'outputVar', type: 'string', description: 'Optional output variable name (handled by runner capture)', required: false }
                ]
            },
            {
                capability: 'system.loop',
                command: 'intentRouter.internal.systemLoop',
                description: 'Iterate over items and run a child pipeline for each item',
                determinism: 'deterministic',
                args: [
                    { name: 'executionMode', type: 'enum', options: ['child_pipeline', 'graph_segment'], description: 'Loop execution mode', required: false, default: 'child_pipeline' },
                    { name: 'items', type: 'string', description: 'Items source: CSV, JSON array, or template-resolved value', required: true },
                    { name: 'pipelinePath', type: 'path', description: 'Child pipeline path (.intent.json)', required: true },
                    { name: 'itemVar', type: 'string', description: 'Runtime var receiving current item', required: false, default: 'loop_item' },
                    { name: 'indexVar', type: 'string', description: 'Runtime var receiving current index', required: false, default: 'loop_index' },
                    { name: 'maxIterations', type: 'string', description: 'Safety limit for iterations', required: false, default: '20' },
                    { name: 'repeatCount', type: 'string', description: 'Number of passes over full items list', required: false, default: '1' },
                    { name: 'dryRunChild', type: 'boolean', description: 'Run child in dry-run mode', required: false, default: false },
                    { name: 'continueOnChildError', type: 'boolean', description: 'Continue loop when child run fails', required: false, default: false },
                    { name: 'errorStrategy', type: 'enum', options: ['fail_fast', 'fail_at_end', 'threshold'], description: 'Failure strategy for loop body', required: false, default: 'fail_fast' },
                    { name: 'errorThreshold', type: 'string', description: 'Allowed failures when strategy=threshold', required: false, default: '1' },
                    { name: 'inputJson', type: 'string', description: 'Optional base runtime variables JSON object', required: false },
                    { name: 'graphStepIds', type: 'string', description: 'Graph-segment source step ids (runtime-managed)', required: false },
                    { name: 'doneStepId', type: 'string', description: 'Graph-segment done target step id (runtime-managed)', required: false },
                    { name: 'outputVar', type: 'string', description: 'Optional output variable name (handled by runner capture)', required: false }
                ]
            },
            {
                capability: 'system.trigger.cron',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Runtime trigger: run pipeline on interval/cron schedule',
                determinism: 'deterministic',
                args: [
                    { name: 'cron', type: 'string', description: 'Cron expression (supports */N minutes or 0 */N hours patterns)', required: false },
                    { name: 'intervalMs', type: 'string', description: 'Interval in milliseconds', required: false },
                    { name: 'everyMinutes', type: 'string', description: 'Interval in minutes', required: false },
                    { name: 'everyHours', type: 'string', description: 'Interval in hours', required: false },
                    { name: 'enabled', type: 'boolean', description: 'Enable trigger', required: false, default: true },
                    { name: 'cooldownMs', type: 'string', description: 'Minimum delay between runs', required: false },
                    { name: 'onSuccessPipeline', type: 'path', description: 'Optional pipeline to run after success', required: false }
                ]
            },
            {
                capability: 'system.trigger.webhook',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Runtime trigger: run pipeline from HTTP webhook',
                determinism: 'interactive',
                args: [
                    { name: 'path', type: 'string', description: 'Webhook path (ex: /factory/idea)', required: true },
                    { name: 'method', type: 'string', description: 'HTTP method', required: false, default: 'POST' },
                    { name: 'secret', type: 'string', description: 'Optional shared secret (x-leion-secret header)', required: false },
                    { name: 'enabled', type: 'boolean', description: 'Enable trigger', required: false, default: true },
                    { name: 'cooldownMs', type: 'string', description: 'Minimum delay between runs', required: false },
                    { name: 'onSuccessPipeline', type: 'path', description: 'Optional pipeline to run after success', required: false }
                ]
            },
            {
                capability: 'system.trigger.watch',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Runtime trigger: run pipeline when files change',
                determinism: 'deterministic',
                args: [
                    { name: 'glob', type: 'string', description: 'Workspace glob pattern (ex: **/*.md)', required: true },
                    { name: 'events', type: 'string', description: 'CSV events: create,change,delete', required: false, default: 'change' },
                    { name: 'enabled', type: 'boolean', description: 'Enable trigger', required: false, default: true },
                    { name: 'debounceMs', type: 'string', description: 'Debounce delay for burst changes', required: false },
                    { name: 'cooldownMs', type: 'string', description: 'Minimum delay between runs', required: false },
                    { name: 'onSuccessPipeline', type: 'path', description: 'Optional pipeline to run after success', required: false }
                ]
            },
            {
                capability: 'memory.save',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Save run memory entry (full run, segment, variables, or raw data)',
                determinism: 'deterministic',
                args: [
                    { name: 'sessionId', type: 'string', description: 'Memory session id', required: true, default: 'default' },
                    { name: 'key', type: 'string', description: 'Memory key (logical bucket)', required: false, default: 'entry' },
                    { name: 'scope', type: 'enum', options: ['full_run', 'run_segment', 'variables', 'raw'], description: 'What to save', required: false, default: 'variables' },
                    { name: 'variableKeys', type: 'string', description: 'CSV variable keys (used by scope=variables)', required: false },
                    { name: 'stepIds', type: 'string', description: 'CSV step ids (used by scope=run_segment)', required: false },
                    { name: 'data', type: 'string', description: 'Raw data payload (used by scope=raw)', required: false },
                    { name: 'tags', type: 'string', description: 'CSV tags', required: false },
                    { name: 'outputVar', type: 'string', description: 'Variable name receiving memory entry id', required: false }
                ]
            },
            {
                capability: 'memory.recall',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Recall memory entries into variables',
                determinism: 'deterministic',
                args: [
                    { name: 'sessionId', type: 'string', description: 'Memory session id', required: true, default: 'default' },
                    { name: 'key', type: 'string', description: 'Optional memory key filter', required: false },
                    { name: 'tag', type: 'string', description: 'Optional tag filter', required: false },
                    { name: 'runId', type: 'string', description: 'Optional run id filter', required: false },
                    { name: 'limit', type: 'string', description: 'Max records', required: false, default: '5' },
                    { name: 'mode', type: 'enum', options: ['latest', 'all'], description: 'Recall mode', required: false, default: 'latest' },
                    { name: 'outputVar', type: 'string', description: 'Variable name for recalled JSON', required: false, default: 'memory_recall' },
                    { name: 'outputVarCount', type: 'string', description: 'Variable name for recalled record count', required: false },
                    { name: 'injectVars', type: 'boolean', description: 'Inject recalled variables into runtime cache', required: false, default: false },
                    { name: 'injectPrefix', type: 'string', description: 'Prefix for injected variables', required: false, default: '' },
                    { name: 'requireMatch', type: 'boolean', description: 'Fail step if recall result is empty', required: false, default: false }
                ]
            },
            {
                capability: 'memory.clear',
                command: 'intentRouter.internal.systemSetVar',
                description: 'Clear memory entries by filter',
                determinism: 'deterministic',
                args: [
                    { name: 'sessionId', type: 'string', description: 'Optional memory session id', required: false },
                    { name: 'key', type: 'string', description: 'Optional memory key', required: false },
                    { name: 'tag', type: 'string', description: 'Optional tag', required: false },
                    { name: 'runId', type: 'string', description: 'Optional run id', required: false },
                    { name: 'keepLast', type: 'string', description: 'Keep N newest matching entries', required: false, default: '0' },
                    { name: 'outputVarRemoved', type: 'string', description: 'Variable name receiving removed count', required: false },
                    { name: 'outputVarRemaining', type: 'string', description: 'Variable name receiving remaining count', required: false }
                ]
            }
        ]
    };

export const aiCapabilities: RegisterCapabilitiesArgs = {
        provider: 'ai',
        type: 'vscode',
        capabilities: [
            {
                capability: 'ai.generate',
                command: 'intentRouter.internal.aiGenerate',
                description: 'Generate code or content using an AI agent',
                determinism: 'interactive',
                args: [
                    { name: 'instruction', type: 'string', description: 'The prompt/instruction for the agent', required: true },
                    { name: 'cwd', type: 'path', description: 'Working directory for CLI execution (inside workspace)' },
                    { name: 'systemPrompt', type: 'string', description: 'Optional system-level constraints applied before instruction' },
                    { name: 'contextFiles', type: 'string', description: 'Glob patterns for context files', default: [] },
                    { name: 'agent', type: 'enum', options: ['gemini', 'codex'], description: 'The AI agent provider', default: 'gemini' },
                    { name: 'model', type: 'string', description: 'Model name override' },
                    { name: 'role', type: 'enum', options: ['brainstorm', 'prd', 'architect', 'backend', 'frontend', 'reviewer', 'qa'], description: 'Agent role profile', default: 'architect' },
                    { name: 'instructionTemplate', type: 'string', description: 'Optional instruction template (supports ${instruction})' },
                    { name: 'outputContract', type: 'enum', options: ['path_result', 'unified_diff'], description: 'Expected AI output contract', default: 'path_result' },
                    { name: 'agentSpecFiles', type: 'string', description: 'Glob patterns for AGENTS.md / SKILL.md', default: [] },
                    { name: 'outputVar', type: 'string', description: 'Variable to store result content' },
                    { name: 'outputVarPath', type: 'string', description: 'Variable to store result path' },
                    { name: 'outputVarChanges', type: 'string', description: 'Variable to store structured changes list' },
                    { name: 'reasoningEffort', type: 'enum', options: ['low', 'medium', 'high', 'extra_high'], description: 'Reasoning depth (codex provider)', default: 'medium' },
                    { name: 'sessionId', type: 'string', description: 'Optional persistent memory session id' },
                    { name: 'sessionMode', type: 'enum', options: ['runtime_only', 'read_only', 'write_only', 'read_write'], description: 'Session memory mode', default: 'read_write' },
                    { name: 'sessionResetBeforeRun', type: 'boolean', description: 'Reset session memory before running agent', default: false },
                    { name: 'sessionRecallLimit', type: 'string', description: 'Max session memory entries injected into prompt', default: '12' }
                ]
            },
            {
                capability: 'ai.team',
                command: 'intentRouter.internal.aiTeam',
                description: 'Execute a team of AI agents in sequence',
                determinism: 'interactive',
                args: [
                    { name: 'strategy', type: 'enum', options: ['sequential', 'reviewer_gate', 'vote'], description: 'Team strategy', default: 'sequential' },
                    { name: 'cwd', type: 'path', description: 'Shared working directory for team members (inside workspace)' },
                    { name: 'systemPrompt', type: 'string', description: 'Optional shared system-level constraints for team members' },
                    { name: 'members', type: 'string', description: 'Team members configuration', required: true },
                    { name: 'contextFiles', type: 'string', description: 'Shared context glob patterns', default: [] },
                    { name: 'agentSpecFiles', type: 'string', description: 'Shared spec files glob patterns', default: [] },
                    { name: 'outputContract', type: 'enum', options: ['path_result', 'unified_diff'], description: 'Expected AI output contract', default: 'path_result' },
                    { name: 'outputVar', type: 'string', description: 'Variable to store final result content' },
                    { name: 'outputVarPath', type: 'string', description: 'Variable to store final result path' },
                    { name: 'outputVarChanges', type: 'string', description: 'Variable to store final structured changes list' },
                    { name: 'sessionId', type: 'string', description: 'Optional persistent memory session id' },
                    { name: 'sessionMode', type: 'enum', options: ['runtime_only', 'read_only', 'write_only', 'read_write'], description: 'Session memory mode', default: 'read_write' },
                    { name: 'sessionResetBeforeRun', type: 'boolean', description: 'Reset session memory before running team', default: false },
                    { name: 'sessionRecallLimit', type: 'string', description: 'Max session memory entries injected into prompt', default: '12' },
                    { name: 'reviewerVoteWeight', type: 'string', description: 'Reviewer weight multiplier when strategy=vote', default: '2' }
                ]
            }
        ]
    };

export const httpCapabilities: RegisterCapabilitiesArgs = {
        provider: 'http',
        type: 'vscode',
        capabilities: [
            {
                capability: 'http.request',
                command: 'intentRouter.internal.httpRequest',
                description: 'Make an HTTP request to an external API',
                determinism: 'deterministic',
                args: [
                    { name: 'url', type: 'string', description: 'Target URL', required: true },
                    { name: 'method', type: 'enum', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP Method', default: 'GET' },
                    { name: 'headers', type: 'string', description: 'JSON string of headers', default: '{}' },
                    { name: 'body', type: 'string', description: 'Request body', default: '' },
                    { name: 'outputVar', type: 'string', description: 'Variable to store response body' }
                ]
            }
        ]
    };

export const githubCapabilities: RegisterCapabilitiesArgs = {
        provider: 'github',
        type: 'vscode',
        capabilities: [
            {
                capability: 'github.openPr',
                command: 'intentRouter.internal.githubOpenPr',
                description: 'Open a GitHub Pull Request with gh CLI',
                determinism: 'deterministic',
                args: [
                    { name: 'head', type: 'string', description: 'Head branch', required: true },
                    { name: 'base', type: 'string', description: 'Base branch', required: true },
                    { name: 'title', type: 'string', description: 'PR title', required: true },
                    { name: 'body', type: 'string', description: 'PR body markdown' },
                    { name: 'bodyFile', type: 'path', description: 'PR body markdown file path' },
                    { name: 'cwd', type: 'path', description: 'Repository working directory', default: '${workspaceRoot}' }
                ]
            },
            {
                capability: 'github.prChecks',
                command: 'intentRouter.internal.githubPrChecks',
                description: 'Fetch checks summary for a PR with gh CLI',
                determinism: 'deterministic',
                args: [
                    { name: 'url', type: 'string', description: 'PR URL (preferred)' },
                    { name: 'number', type: 'string', description: 'PR number (fallback)' },
                    { name: 'repo', type: 'string', description: 'repo owner/name (fallback)' },
                    { name: 'cwd', type: 'path', description: 'Repository working directory', default: '${workspaceRoot}' }
                ]
            },
            {
                capability: 'github.prRerunFailedChecks',
                command: 'intentRouter.internal.githubPrRerunFailedChecks',
                description: 'Re-run failed checks for a PR with gh CLI',
                determinism: 'deterministic',
                args: [
                    { name: 'url', type: 'string', description: 'PR URL (preferred)' },
                    { name: 'number', type: 'string', description: 'PR number (fallback)' },
                    { name: 'repo', type: 'string', description: 'repo owner/name (fallback)' },
                    { name: 'cwd', type: 'path', description: 'Repository working directory', default: '${workspaceRoot}' }
                ]
            },
            {
                capability: 'github.prComment',
                command: 'intentRouter.internal.githubPrComment',
                description: 'Post a comment on a PR with gh CLI',
                determinism: 'interactive',
                args: [
                    { name: 'url', type: 'string', description: 'PR URL (preferred)' },
                    { name: 'number', type: 'string', description: 'PR number (fallback)' },
                    { name: 'repo', type: 'string', description: 'repo owner/name (fallback)' },
                    { name: 'body', type: 'string', description: 'Comment body', required: true },
                    { name: 'cwd', type: 'path', description: 'Repository working directory', default: '${workspaceRoot}' }
                ]
            }
        ]
    };

export const builtinCapabilityRegistrations: RegisterCapabilitiesArgs[] = [
    gitCapabilities, dockerCapabilities, terminalCapabilities, systemCapabilities, aiCapabilities, httpCapabilities, githubCapabilities
];
