import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

const core: any = require('../../core/out/index');

type TabId = 'run' | 'pipelines' | 'editor' | 'history' | 'diff' | 'triggers' | 'hitl';

type AppProps = {
    workspaceRoot: string;
    initialRunId?: string;
    initialPipeline?: string;
};

type TuiRuntimeConfig = {
    maxLogs: number;
    maxEvents: number;
};

const theme = {
    bg: 'black',
    fg: 'white',
    muted: 'gray',
    accent: 'cyan',
    accent2: 'magenta',
    ok: 'green',
    warn: 'yellow',
    err: 'red'
} as const;

function toPositiveInt(input: any, fallback: number): number {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function loadTuiConfig(workspaceRoot: string): TuiRuntimeConfig {
    const configPath = path.join(workspaceRoot, '.intent-router', 'config.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const maxLogs = toPositiveInt(
            parsed?.intentRouter?.tui?.logs?.maxLines ?? parsed?.['intentRouter.tui.logs.maxLines'],
            2000
        );
        const maxEvents = toPositiveInt(
            parsed?.intentRouter?.tui?.events?.maxItems ?? parsed?.['intentRouter.tui.events.maxItems'],
            5000
        );
        return { maxLogs, maxEvents };
    } catch {
        return { maxLogs: 2000, maxEvents: 5000 };
    }
}

function formatTime(value: any): string {
    const ts = Number(value || Date.now());
    if (!Number.isFinite(ts)) return '--:--:--';
    return new Date(ts).toLocaleTimeString();
}

function boundedAppend(lines: string[], next: string[], maxItems: number): string[] {
    const merged = [...lines, ...next];
    if (merged.length <= maxItems) return merged;
    return merged.slice(merged.length - maxItems);
}

function tailWindow(lines: string[], windowSize: number, offsetFromEnd: number): string[] {
    const safeOffset = Math.max(0, offsetFromEnd);
    const end = Math.max(0, lines.length - safeOffset);
    const start = Math.max(0, end - Math.max(1, windowSize));
    return lines.slice(start, end);
}

function formatEventLine(event: any): string {
    const ts = formatTime(event?.ts);
    const type = String(event?.type || 'unknown');
    const payload = event?.payload || {};
    if (type === 'stepLog') {
        return `[${ts}] ${type}: ${String(payload?.text || '').trim()}`;
    }
    if (type === 'stepStart' || type === 'stepEnd') {
        return `[${ts}] ${type} ${String(payload?.stepId || payload?.intentId || '')}`.trim();
    }
    if (type.startsWith('run.')) {
        return `[${ts}] ${type}`;
    }
    return `[${ts}] ${type}`;
}

function tryExtractLogLine(event: any): string | undefined {
    if (String(event?.type || '') !== 'stepLog') return undefined;
    const payload = event?.payload || {};
    const text = String(payload?.text || '').trim();
    if (!text) return undefined;
    return `[${formatTime(event?.ts)}] ${text}`;
}

function pad(label: string, active: boolean): string {
    return active ? `> ${label}` : `  ${label}`;
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | 'gray' | 'cyan' {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'success' || normalized === 'running') return 'green';
    if (normalized.includes('pause') || normalized === 'starting') return 'yellow';
    if (normalized === 'failure' || normalized === 'cancelled' || normalized === 'cancel_requested') return 'red';
    return 'gray';
}

function tabLabel(label: string, active: boolean): string {
    return active ? label : label;
}

function sectionTitle(text: string): string {
    return `┏ ${text}`;
}

function generatePipelineName(): string {
    return `pipeline_${Date.now().toString(36).slice(-8)}`;
}

function escapeYamlSingleQuoted(value: string): string {
    return String(value || '').replace(/'/g, "''");
}

function buildActionNodeYaml(step: any, patch?: {
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

function buildPipelineYaml(pipeline: any): string {
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

function buildAddNodeTemplate(nextId: string): string {
    return [
        `type: action`,
        `node_position: '${escapeYamlSingleQuoted(nextId)}'`,
        `description: 'New runtime step'`,
        `intent: 'terminal.run'`,
        `payload:`,
        `  {"command":"echo ${nextId}"}`
    ].join('\n');
}

function editTextWithEditor(initialText: string): { ok: boolean; text?: string; error?: string } {
    const tempFile = path.join(os.tmpdir(), `leion-node-${Date.now().toString(36)}.yaml`);
    const decorated = [
        '# Leion TUI YAML Editor',
        '# Save + quit to apply. Leave node_position unchanged.',
        '',
        initialText
    ].join('\n');
    fs.writeFileSync(tempFile, `${decorated}\n`, 'utf8');
    const editor = String(process.env.LEION_TUI_EDITOR || process.env.VISUAL || process.env.EDITOR || 'vi').trim();
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

export function App(props: AppProps): JSX.Element {
    const { exit } = useApp();
    const [tab, setTab] = useState<TabId>('run');
    const [statusLine, setStatusLine] = useState<string>('Ready');
    const [runs, setRuns] = useState<any[]>([]);
    const [selectedRunIndex, setSelectedRunIndex] = useState(0);
    const [eventLines, setEventLines] = useState<string[]>([]);
    const [logLines, setLogLines] = useState<string[]>([]);
    const [eventOffset, setEventOffset] = useState(0);
    const [logOffset, setLogOffset] = useState(0);
    const [pipelines, setPipelines] = useState<any[]>([]);
    const [selectedPipelineIndex, setSelectedPipelineIndex] = useState(0);
    const [historyRows, setHistoryRows] = useState<any[]>([]);
    const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(0);
    const [triggerRows, setTriggerRows] = useState<any[]>([]);
    const [selectedTriggerIndex, setSelectedTriggerIndex] = useState(0);
    const [approvals, setApprovals] = useState<any[]>([]);
    const [selectedApprovalIndex, setSelectedApprovalIndex] = useState(0);
    const [editorNodes, setEditorNodes] = useState<any[]>([]);
    const [selectedEditorNodeIndex, setSelectedEditorNodeIndex] = useState(0);
    const [diffLines, setDiffLines] = useState<string[]>([]);
    const [diffSource, setDiffSource] = useState<'audit' | 'git' | 'none'>('none');
    const [promptTitle, setPromptTitle] = useState<string>('');
    const [promptValue, setPromptValue] = useState<string>('');
    const [promptOpen, setPromptOpen] = useState(false);
    const promptSubmitRef = useRef<((value: string) => void) | null>(null);
    const config = useMemo(() => loadTuiConfig(props.workspaceRoot), [props.workspaceRoot]);
    const runtime = useMemo(() => {
        return new core.CoreRuntime({
            workspaceRoot: props.workspaceRoot,
            blockedIntentPrefixes: ['vscode.']
        });
    }, [props.workspaceRoot]);
    const supervisor = useMemo(() => new core.RunSupervisorService(props.workspaceRoot), [props.workspaceRoot]);
    const catalog = useMemo(() => new core.PipelineCatalogService(props.workspaceRoot), [props.workspaceRoot]);
    const historyService = useMemo(() => new core.HistoryService(runtime), [runtime]);
    const triggerService = useMemo(() => new core.TriggerService(runtime), [runtime]);
    const approvalService = useMemo(() => new core.ApprovalInboxService(runtime, true), [runtime]);
    const diffService = useMemo(() => new core.DiffService(runtime), [runtime]);
    const dslService = useMemo(() => new core.DslMutationService(props.workspaceRoot), [props.workspaceRoot]);
    const selectedRunCursorRef = useRef<number>(0);
    const selectedRunIdRef = useRef<string>('');

    const openPrompt = useCallback((title: string, initialValue: string, onSubmit: (value: string) => void) => {
        setPromptTitle(title);
        setPromptValue(initialValue);
        promptSubmitRef.current = onSubmit;
        setPromptOpen(true);
    }, []);

    const selectedRun = runs[selectedRunIndex];
    const selectedRunId = String(selectedRun?.detachedRunId || selectedRun?.pipelineRunId || '').trim();
    const selectedPipeline = pipelines[selectedPipelineIndex];
    const selectedEditorNode = editorNodes[selectedEditorNodeIndex];

    const refreshRuns = useCallback(() => {
        try {
            const rows = supervisor.list_runs();
            setRuns(rows);
            if (rows.length === 0) {
                setSelectedRunIndex(0);
                return;
            }
            if (props.initialRunId) {
                const idx = rows.findIndex((entry: any) => {
                    return (
                        String(entry?.detachedRunId || '') === props.initialRunId
                        || String(entry?.pipelineRunId || '') === props.initialRunId
                    );
                });
                if (idx >= 0) setSelectedRunIndex(idx);
            } else if (selectedRunIndex >= rows.length) {
                setSelectedRunIndex(rows.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`Runs refresh failed: ${String(error?.message || error)}`);
        }
    }, [props.initialRunId, selectedRunIndex, supervisor]);

    const refreshPipelines = useCallback(() => {
        try {
            const rows = catalog.list();
            setPipelines(rows);
            if (!rows.length) return;
            if (props.initialPipeline) {
                const idx = rows.findIndex((entry: any) => {
                    return (
                        String(entry?.name || '') === props.initialPipeline
                        || String(entry?.path || '') === props.initialPipeline
                    );
                });
                if (idx >= 0) setSelectedPipelineIndex(idx);
            } else if (selectedPipelineIndex >= rows.length) {
                setSelectedPipelineIndex(rows.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`Pipelines refresh failed: ${String(error?.message || error)}`);
        }
    }, [catalog, props.initialPipeline, selectedPipelineIndex]);

    const refreshHistory = useCallback(async () => {
        try {
            const rows = await historyService.list();
            setHistoryRows(Array.isArray(rows) ? rows : []);
            if (selectedHistoryIndex >= rows.length && rows.length > 0) {
                setSelectedHistoryIndex(rows.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`History refresh failed: ${String(error?.message || error)}`);
        }
    }, [historyService, selectedHistoryIndex]);

    const refreshTriggers = useCallback(() => {
        try {
            const rows = triggerService.list();
            setTriggerRows(rows);
            if (selectedTriggerIndex >= rows.length && rows.length > 0) {
                setSelectedTriggerIndex(rows.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`Triggers refresh failed: ${String(error?.message || error)}`);
        }
    }, [selectedTriggerIndex, triggerService]);

    const refreshApprovals = useCallback(() => {
        try {
            const rows = approvalService.list_pending();
            setApprovals(rows);
            if (selectedApprovalIndex >= rows.length && rows.length > 0) {
                setSelectedApprovalIndex(rows.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`Approvals refresh failed: ${String(error?.message || error)}`);
        }
    }, [approvalService, selectedApprovalIndex]);

    const refreshEditorNodes = useCallback(() => {
        const selectedPipeline = pipelines[selectedPipelineIndex];
        if (!selectedPipeline?.path) {
            setEditorNodes([]);
            setSelectedEditorNodeIndex(0);
            return;
        }
        try {
            const pipeline = catalog.load(String(selectedPipeline.path));
            const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
            setEditorNodes(steps);
            if (selectedEditorNodeIndex >= steps.length && steps.length > 0) {
                setSelectedEditorNodeIndex(steps.length - 1);
            }
        } catch (error: any) {
            setStatusLine(`Editor load failed: ${String(error?.message || error)}`);
        }
    }, [catalog, pipelines, selectedEditorNodeIndex, selectedPipelineIndex]);

    const refreshDiff = useCallback(async () => {
        const row = historyRows[selectedHistoryIndex];
        const runId = String(row?.id || '').trim();
        if (!runId) {
            setDiffSource('none');
            setDiffLines([]);
            return;
        }
        try {
            const result = await diffService.get_run_diff(runId);
            setDiffSource(result.source);
            setDiffLines(Array.isArray(result.lines) ? result.lines : []);
        } catch (error: any) {
            setStatusLine(`Diff refresh failed: ${String(error?.message || error)}`);
        }
    }, [diffService, historyRows, selectedHistoryIndex]);

    const replaceSelectedNodeFromYaml = useCallback((yamlPayload: string) => {
        const pipelinePath = String(selectedPipeline?.path || '').trim();
        if (!pipelinePath) {
            setStatusLine('No selected pipeline for editor action.');
            return;
        }
        try {
            dslService.replace_node(pipelinePath, yamlPayload);
            refreshEditorNodes();
            refreshPipelines();
            setStatusLine('Node updated.');
        } catch (error: any) {
            setStatusLine(`Replace failed: ${String(error?.message || error)}`);
        }
    }, [dslService, refreshEditorNodes, refreshPipelines, selectedPipeline?.path]);

    const patchSelectedNode = useCallback((patch: { intent?: string; description?: string; onFailure?: string; payload?: any }) => {
        if (!selectedEditorNode) {
            setStatusLine('No selected node.');
            return;
        }
        const yamlPayload = buildActionNodeYaml(selectedEditorNode, patch);
        replaceSelectedNodeFromYaml(yamlPayload);
    }, [replaceSelectedNodeFromYaml, selectedEditorNode]);

    useEffect(() => {
        refreshRuns();
        refreshPipelines();
        void refreshHistory();
        refreshTriggers();
        refreshApprovals();
    }, [refreshApprovals, refreshHistory, refreshPipelines, refreshRuns, refreshTriggers]);

    useEffect(() => {
        refreshEditorNodes();
    }, [refreshEditorNodes]);

    useEffect(() => {
        void refreshDiff();
    }, [refreshDiff]);

    useEffect(() => {
        const timer = setInterval(refreshRuns, 1000);
        return () => clearInterval(timer);
    }, [refreshRuns]);

    useEffect(() => {
        const timer = setInterval(refreshPipelines, 2000);
        return () => clearInterval(timer);
    }, [refreshPipelines]);

    useEffect(() => {
        const timer = setInterval(refreshEditorNodes, 2500);
        return () => clearInterval(timer);
    }, [refreshEditorNodes]);

    useEffect(() => {
        const timer = setInterval(() => void refreshHistory(), 2500);
        return () => clearInterval(timer);
    }, [refreshHistory]);

    useEffect(() => {
        const timer = setInterval(() => void refreshDiff(), 2500);
        return () => clearInterval(timer);
    }, [refreshDiff]);

    useEffect(() => {
        const timer = setInterval(refreshTriggers, 2500);
        return () => clearInterval(timer);
    }, [refreshTriggers]);

    useEffect(() => {
        const timer = setInterval(refreshApprovals, 1500);
        return () => clearInterval(timer);
    }, [refreshApprovals]);

    useEffect(() => {
        const previous = selectedRunIdRef.current;
        if (selectedRunId && previous !== selectedRunId) {
            selectedRunCursorRef.current = 0;
            selectedRunIdRef.current = selectedRunId;
            setEventLines([]);
            setLogLines([]);
            setEventOffset(0);
            setLogOffset(0);
        }
    }, [selectedRunId]);

    useEffect(() => {
        if (!selectedRunId) return;
        const timer = setInterval(() => {
            try {
                const tail = supervisor.tail_events(selectedRunId, selectedRunCursorRef.current);
                selectedRunCursorRef.current = tail.nextCursor;
                if (!Array.isArray(tail.events) || tail.events.length === 0) return;
                const nextEventLines = tail.events.map((event: any) => formatEventLine(event));
                const nextLogLines = tail.events
                    .map((event: any) => tryExtractLogLine(event))
                    .filter((entry: string | undefined): entry is string => Boolean(entry));
                setEventLines((prev) => boundedAppend(prev, nextEventLines, config.maxEvents));
                if (nextLogLines.length > 0) {
                    setLogLines((prev) => boundedAppend(prev, nextLogLines, config.maxLogs));
                }
            } catch {
                // ignore short race conditions during run file creation
            }
        }, 450);
        return () => clearInterval(timer);
    }, [config.maxEvents, config.maxLogs, selectedRunId, supervisor]);

    useEffect(() => {
        return () => {
            approvalService.dispose();
            void runtime.stop_triggers();
        };
    }, [approvalService, runtime]);

    useInput((input, key) => {
        if (promptOpen) {
            if (key.escape) {
                setPromptOpen(false);
                promptSubmitRef.current = null;
                setStatusLine('Prompt cancelled');
                return;
            }
            if (key.return) {
                const submit = promptSubmitRef.current;
                setPromptOpen(false);
                promptSubmitRef.current = null;
                if (submit) {
                    submit(promptValue);
                }
                return;
            }
            if (key.backspace || key.delete) {
                setPromptValue((prev) => prev.slice(0, -1));
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                setPromptValue((prev) => `${prev}${input}`);
            }
            return;
        }

        if ((key.ctrl && input === 'c') || input === 'q') {
            exit();
            return;
        }
        if (input === '1') setTab('run');
        if (input === '2') setTab('pipelines');
        if (input === '3') setTab('editor');
        if (input === '4') setTab('history');
        if (input === '5') setTab('diff');
        if (input === '6') setTab('triggers');
        if (input === '7') setTab('hitl');

        if (tab === 'run') {
            if (key.upArrow && runs.length > 0) {
                setSelectedRunIndex((prev) => Math.max(0, prev - 1));
                return;
            }
            if (key.downArrow && runs.length > 0) {
                setSelectedRunIndex((prev) => Math.min(runs.length - 1, prev + 1));
                return;
            }
            if (input === '[') setEventOffset((prev) => prev + 25);
            if (input === ']') setEventOffset((prev) => Math.max(0, prev - 25));
            if (input === '{') setLogOffset((prev) => prev + 25);
            if (input === '}') setLogOffset((prev) => Math.max(0, prev - 25));
            if (input === 'l') {
                refreshRuns();
                setStatusLine('Runs refreshed');
            }
            if (input === 'p' && selectedRunId) {
                try {
                    supervisor.pause_run(selectedRunId);
                    setStatusLine(`Pause requested for ${selectedRunId}`);
                } catch (error: any) {
                    setStatusLine(`Pause failed: ${String(error?.message || error)}`);
                }
            }
            if (input === 'r' && selectedRunId) {
                try {
                    supervisor.resume_run(selectedRunId);
                    setStatusLine(`Resume requested for ${selectedRunId}`);
                } catch (error: any) {
                    setStatusLine(`Resume failed: ${String(error?.message || error)}`);
                }
            }
            if (input === 'c' && selectedRunId) {
                try {
                    supervisor.cancel_run(selectedRunId);
                    setStatusLine(`Cancel requested for ${selectedRunId}`);
                } catch (error: any) {
                    setStatusLine(`Cancel failed: ${String(error?.message || error)}`);
                }
            }
            return;
        }

        if (tab === 'pipelines') {
            const startDetached = (entry: any) => {
                try {
                    const out = supervisor.start_detached({
                        pipeline: String(entry?.path || entry?.name || ''),
                        dryRun: false
                    });
                    setStatusLine(`Detached run started: ${String(out?.run_id || '')}`);
                    refreshRuns();
                } catch (error: any) {
                    setStatusLine(`Run failed: ${String(error?.message || error)}`);
                }
            };
            if (key.upArrow && pipelines.length > 0) {
                setSelectedPipelineIndex((prev) => Math.max(0, prev - 1));
                return;
            }
            if (key.downArrow && pipelines.length > 0) {
                setSelectedPipelineIndex((prev) => Math.min(pipelines.length - 1, prev + 1));
                return;
            }
            if (key.return && pipelines.length > 0) {
                const entry = pipelines[selectedPipelineIndex];
                if (!entry) return;
                startDetached(entry);
                return;
            }
            if (input === 'r' && pipelines.length > 0) {
                const entry = pipelines[selectedPipelineIndex];
                if (!entry) return;
                startDetached(entry);
                return;
            }
            if (input === 'd' && pipelines.length > 0) {
                const entry = pipelines[selectedPipelineIndex];
                if (!entry) return;
                void runtime.run_pipeline_file(String(entry.path || ''), { dryRun: true })
                    .then((result: any) => {
                        setStatusLine(`Dry-run ${result?.success ? 'ok' : 'failed'} (${String(result?.runId || '-')})`);
                    })
                    .catch((error: any) => {
                        setStatusLine(`Dry-run failed: ${String(error?.message || error)}`);
                    });
                return;
            }
            if (input === 'n') {
                const name = generatePipelineName();
                try {
                    catalog.create(name);
                    refreshPipelines();
                    setStatusLine(`Pipeline created: ${name}`);
                } catch (error: any) {
                    setStatusLine(`Create failed: ${String(error?.message || error)}`);
                }
                return;
            }
            if (input === 'x' && pipelines.length > 0) {
                const entry = pipelines[selectedPipelineIndex];
                if (!entry) return;
                try {
                    catalog.delete(String(entry.path || entry.name || ''));
                    refreshPipelines();
                    refreshEditorNodes();
                    setStatusLine(`Pipeline deleted: ${String(entry.name || '-')}`);
                } catch (error: any) {
                    setStatusLine(`Delete failed: ${String(error?.message || error)}`);
                }
                return;
            }
            if (input === 'e') {
                setTab('editor');
                return;
            }
            return;
        }

        if (tab === 'editor') {
            if (key.upArrow && editorNodes.length > 0) {
                setSelectedEditorNodeIndex((prev) => Math.max(0, prev - 1));
                return;
            }
            if (key.downArrow && editorNodes.length > 0) {
                setSelectedEditorNodeIndex((prev) => Math.min(editorNodes.length - 1, prev + 1));
                return;
            }
            if (!selectedPipeline?.path) {
                return;
            }
            if (input === 'u' && editorNodes.length > 1) {
                const ids = editorNodes.map((entry: any) => String(entry?.id || '').trim()).filter(Boolean);
                const idx = selectedEditorNodeIndex;
                if (idx > 0) {
                    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
                    try {
                        dslService.reorder_nodes(String(selectedPipeline.path), ids);
                        setSelectedEditorNodeIndex(idx - 1);
                        refreshEditorNodes();
                        refreshPipelines();
                        setStatusLine('Node moved up');
                    } catch (error: any) {
                        setStatusLine(`Reorder failed: ${String(error?.message || error)}`);
                    }
                }
                return;
            }
            if (input === 'j' && editorNodes.length > 1) {
                const ids = editorNodes.map((entry: any) => String(entry?.id || '').trim()).filter(Boolean);
                const idx = selectedEditorNodeIndex;
                if (idx < ids.length - 1) {
                    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
                    try {
                        dslService.reorder_nodes(String(selectedPipeline.path), ids);
                        setSelectedEditorNodeIndex(idx + 1);
                        refreshEditorNodes();
                        refreshPipelines();
                        setStatusLine('Node moved down');
                    } catch (error: any) {
                        setStatusLine(`Reorder failed: ${String(error?.message || error)}`);
                    }
                }
                return;
            }
            if (input === 'x' && editorNodes.length > 0) {
                const node = editorNodes[selectedEditorNodeIndex];
                const nodeId = String(node?.id || '').trim();
                if (!nodeId) return;
                try {
                    dslService.delete_node(String(selectedPipeline.path), nodeId);
                    setStatusLine(`Node deleted: ${nodeId}`);
                    refreshEditorNodes();
                    refreshPipelines();
                } catch (error: any) {
                    setStatusLine(`Delete failed: ${String(error?.message || error)}`);
                }
                return;
            }
            if (input === 'a') {
                const nextId = `node_${Date.now().toString(36).slice(-6)}`;
                const yamlPayload = buildAddNodeTemplate(nextId);
                setStatusLine('Opening YAML editor for new node...');
                const edited = editTextWithEditor(yamlPayload);
                if (!edited.ok || !edited.text) {
                    setStatusLine(edited.error || 'YAML editor aborted');
                    return;
                }
                try {
                    dslService.add_node(String(selectedPipeline.path), edited.text);
                    setStatusLine('Node added.');
                    refreshEditorNodes();
                    refreshPipelines();
                } catch (error: any) {
                    setStatusLine(`Add failed: ${String(error?.message || error)}`);
                }
                return;
            }

            if (input === 'v') {
                try {
                    const pipeline = catalog.load(String(selectedPipeline.path));
                    const yamlPayload = buildPipelineYaml(pipeline);
                    setStatusLine('Opening full pipeline YAML editor...');
                    const edited = editTextWithEditor(yamlPayload);
                    if (!edited.ok || !edited.text) {
                        setStatusLine(edited.error || 'YAML editor aborted');
                        return;
                    }
                    dslService.edit_pipeline(String(selectedPipeline.path), edited.text);
                    refreshEditorNodes();
                    refreshPipelines();
                    setStatusLine('Pipeline YAML updated.');
                } catch (error: any) {
                    setStatusLine(`Pipeline YAML edit failed: ${String(error?.message || error)}`);
                }
                return;
            }

            if (input === 'i' && selectedEditorNode) {
                openPrompt(
                    'Set intent',
                    String(selectedEditorNode.intent || ''),
                    (value) => patchSelectedNode({ intent: String(value || '').trim() })
                );
                return;
            }

            if (input === 'm' && selectedEditorNode) {
                openPrompt(
                    'Set description (empty clears)',
                    String(selectedEditorNode.description || ''),
                    (value) => patchSelectedNode({ description: String(value || '') })
                );
                return;
            }

            if (input === 'o' && selectedEditorNode) {
                openPrompt(
                    'Set on_failure target (empty clears)',
                    String(selectedEditorNode.onFailure || ''),
                    (value) => patchSelectedNode({ onFailure: String(value || '') })
                );
                return;
            }

            if (input === 'c' && selectedEditorNode) {
                const payload = selectedEditorNode.payload && typeof selectedEditorNode.payload === 'object'
                    ? selectedEditorNode.payload
                    : {};
                openPrompt(
                    'Set payload.command',
                    String(payload.command || ''),
                    (value) => patchSelectedNode({ payload: { ...payload, command: String(value || '') } })
                );
                return;
            }

            if (input === 'y' && selectedEditorNode) {
                const yaml = buildActionNodeYaml(selectedEditorNode);
                setStatusLine('Opening YAML editor...');
                const edited = editTextWithEditor(yaml);
                if (!edited.ok || !edited.text) {
                    setStatusLine(edited.error || 'YAML editor aborted');
                    return;
                }
                replaceSelectedNodeFromYaml(edited.text);
                return;
            }
            return;
        }

        if (tab === 'history') {
            if (key.upArrow && historyRows.length > 0) setSelectedHistoryIndex((prev) => Math.max(0, prev - 1));
            if (key.downArrow && historyRows.length > 0) setSelectedHistoryIndex((prev) => Math.min(historyRows.length - 1, prev + 1));
            return;
        }

        if (tab === 'diff') {
            if (input === 'f') {
                void refreshDiff();
                setStatusLine('Diff refreshed');
            }
            return;
        }

        if (tab === 'triggers') {
            if (key.upArrow && triggerRows.length > 0) setSelectedTriggerIndex((prev) => Math.max(0, prev - 1));
            if (key.downArrow && triggerRows.length > 0) setSelectedTriggerIndex((prev) => Math.min(triggerRows.length - 1, prev + 1));
            if (input === 's') {
                void triggerService.start()
                    .then(() => setStatusLine('Triggers started'))
                    .catch((error: any) => setStatusLine(`Triggers start failed: ${String(error?.message || error)}`));
            }
            if (input === 'x') {
                void triggerService.stop()
                    .then(() => setStatusLine('Triggers stopped'))
                    .catch((error: any) => setStatusLine(`Triggers stop failed: ${String(error?.message || error)}`));
            }
            if (input === 'f') {
                void triggerService.refresh()
                    .then(() => {
                        refreshTriggers();
                        setStatusLine('Triggers refreshed');
                    })
                    .catch((error: any) => setStatusLine(`Triggers refresh failed: ${String(error?.message || error)}`));
            }
            return;
        }

        if (tab === 'hitl') {
            if (key.upArrow && approvals.length > 0) setSelectedApprovalIndex((prev) => Math.max(0, prev - 1));
            if (key.downArrow && approvals.length > 0) setSelectedApprovalIndex((prev) => Math.min(approvals.length - 1, prev + 1));
            const selected = approvals[selectedApprovalIndex];
            if (!selected) return;
            if (input === 'a') {
                try {
                    approvalService.resolve({ pendingId: selected.id, decision: 'approve' });
                    setStatusLine(`Approved ${String(selected.id)}`);
                    refreshApprovals();
                } catch (error: any) {
                    setStatusLine(`Approve failed: ${String(error?.message || error)}`);
                }
            }
            if (input === 'r') {
                try {
                    approvalService.resolve({ pendingId: selected.id, decision: 'reject' });
                    setStatusLine(`Rejected ${String(selected.id)}`);
                    refreshApprovals();
                } catch (error: any) {
                    setStatusLine(`Reject failed: ${String(error?.message || error)}`);
                }
            }
        }
    });

    const selectedHistory = historyRows[selectedHistoryIndex];
    const selectedTrigger = triggerRows[selectedTriggerIndex];
    const selectedApproval = approvals[selectedApprovalIndex];
    const visibleEvents = tailWindow(eventLines, 22, eventOffset);
    const visibleLogs = tailWindow(logLines, 12, logOffset);

    return (
        <Box flexDirection="column" paddingX={1}>
            <Box borderStyle="round" borderColor="cyan" paddingX={1}>
                <Box flexDirection="column" flexGrow={1}>
                    <Text color="cyanBright">LEION ROOTS TUI</Text>
                    <Text color="gray">Workspace: {props.workspaceRoot}</Text>
                </Box>
                <Text color={statusColor(String(selectedRun?.status || 'idle'))}>
                    {String(selectedRun?.status || 'idle').toUpperCase()}
                </Text>
            </Box>

            <Box borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
                <Text color={tab === 'run' ? 'black' : 'cyan'} backgroundColor={tab === 'run' ? 'cyan' : undefined}>{tabLabel('1 Run', tab === 'run')}</Text>
                <Text> </Text>
                <Text color={tab === 'pipelines' ? 'black' : 'cyan'} backgroundColor={tab === 'pipelines' ? 'cyan' : undefined}>{tabLabel('2 Pipelines', tab === 'pipelines')}</Text>
                <Text> </Text>
                <Text color={tab === 'editor' ? 'black' : 'cyan'} backgroundColor={tab === 'editor' ? 'cyan' : undefined}>{tabLabel('3 Editor', tab === 'editor')}</Text>
                <Text> </Text>
                <Text color={tab === 'history' ? 'black' : 'cyan'} backgroundColor={tab === 'history' ? 'cyan' : undefined}>{tabLabel('4 History', tab === 'history')}</Text>
                <Text> </Text>
                <Text color={tab === 'diff' ? 'black' : 'cyan'} backgroundColor={tab === 'diff' ? 'cyan' : undefined}>{tabLabel('5 Diff', tab === 'diff')}</Text>
                <Text> </Text>
                <Text color={tab === 'triggers' ? 'black' : 'cyan'} backgroundColor={tab === 'triggers' ? 'cyan' : undefined}>{tabLabel('6 Triggers', tab === 'triggers')}</Text>
                <Text> </Text>
                <Text color={tab === 'hitl' ? 'black' : 'cyan'} backgroundColor={tab === 'hitl' ? 'cyan' : undefined}>{tabLabel('7 HITL', tab === 'hitl')}</Text>
            </Box>

            {tab === 'run' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="35%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle(`Runs (${runs.length})`)}</Text>
                        <Text color="gray">↑/↓ select, p pause, r resume, c cancel</Text>
                        {runs.slice(0, 20).map((entry, idx) => {
                            const selected = idx === selectedRunIndex;
                            const id = String(entry?.detachedRunId || entry?.pipelineRunId || '?');
                            return (
                                <Text key={id} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {id} [<Text color={statusColor(String(entry?.status || '-'))}>{String(entry?.status || '-')}</Text>]
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="65%" borderStyle="round" borderColor="magenta" paddingX={1}>
                        <Text color="magentaBright">{sectionTitle(`Events ${eventLines.length}/${config.maxEvents}`)}</Text>
                        <Text color="gray">[ / ] scroll</Text>
                        {visibleEvents.map((line, idx) => (
                            <Text key={`ev-${idx}`}>{line}</Text>
                        ))}
                        <Text color="magentaBright">{sectionTitle(`Logs ${logLines.length}/${config.maxLogs}`)}</Text>
                        <Text color="gray">{'{ / }'} scroll</Text>
                        {visibleLogs.map((line, idx) => (
                            <Text key={`log-${idx}`}>{line}</Text>
                        ))}
                    </Box>
                </Box>
            )}

            {tab === 'pipelines' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="45%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle(`Pipelines (${pipelines.length})`)}</Text>
                        <Text color="gray">↑/↓, Enter/r run, d dry-run, n new, x delete, e editor</Text>
                        {pipelines.slice(0, 30).map((entry, idx) => {
                            const selected = idx === selectedPipelineIndex;
                            const key = String(entry?.path || idx);
                            return (
                                <Text key={key} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {String(entry?.name || '?')}
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="55%" borderStyle="round" borderColor="yellow" paddingX={1}>
                        <Text color="yellowBright">{sectionTitle('Selected Pipeline')}</Text>
                        <Text>{String(pipelines[selectedPipelineIndex]?.path || '-')}</Text>
                    </Box>
                </Box>
            )}

            {tab === 'editor' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="45%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle('Nodes')}</Text>
                        <Text color="gray">↑/↓ select | a add(yaml) | y edit node yaml | v full pipeline yaml</Text>
                        <Text color="gray">x delete | u/j reorder | i intent | m desc | o on_failure | c command</Text>
                        {editorNodes.slice(0, 35).map((entry, idx) => {
                            const selected = idx === selectedEditorNodeIndex;
                            const key = String(entry?.id || idx);
                            return (
                                <Text key={key} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {String(entry?.id || '?')} :: {String(entry?.intent || '-')}
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="55%" borderStyle="round" borderColor="blue" paddingX={1}>
                        <Text color="blueBright">{sectionTitle('Node Inspector')}</Text>
                        <Text color="gray">pipeline: {String(pipelines[selectedPipelineIndex]?.path || '-')}</Text>
                        <Text>id: {String(selectedEditorNode?.id || '-')}</Text>
                        <Text>intent: {String(selectedEditorNode?.intent || '-')}</Text>
                        <Text>description: {String(selectedEditorNode?.description || '-')}</Text>
                        <Text>onFailure: {String(selectedEditorNode?.onFailure || '-')}</Text>
                        <Text>command: {String(selectedEditorNode?.payload?.command || '-')}</Text>
                    </Box>
                </Box>
            )}

            {tab === 'history' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="45%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle(`History (${historyRows.length})`)}</Text>
                        <Text color="gray">↑/↓ select</Text>
                        {historyRows.slice(0, 30).map((entry, idx) => {
                            const selected = idx === selectedHistoryIndex;
                            const key = String(entry?.id || idx);
                            return (
                                <Text key={key} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {String(entry?.id || '?')} [{String(entry?.status || '-')}] {formatTime(entry?.timestamp)}
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="55%" borderStyle="round" borderColor="yellow" paddingX={1}>
                        <Text color="yellowBright">{sectionTitle('Selected Run Detail')}</Text>
                        <Text>id: {String(selectedHistory?.id || '-')}</Text>
                        <Text>name: {String(selectedHistory?.name || '-')}</Text>
                        <Text>status: <Text color={statusColor(String(selectedHistory?.status || '-'))}>{String(selectedHistory?.status || '-')}</Text></Text>
                        <Text>steps: {String(Array.isArray(selectedHistory?.steps) ? selectedHistory.steps.length : 0)}</Text>
                    </Box>
                </Box>
            )}

            {tab === 'diff' && (
                <Box marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
                    <Text color="magentaBright">{sectionTitle(`Diff source: ${diffSource}`)}</Text>
                    <Text color="gray">f refresh</Text>
                    {diffLines.length === 0 && <Text color="gray">No diff data available.</Text>}
                    {diffLines.slice(0, 40).map((line, idx) => (
                        <Text key={`diff-${idx}`}>{line}</Text>
                    ))}
                </Box>
            )}

            {tab === 'triggers' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="45%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle(`Triggers (${triggerRows.length})`)}</Text>
                        <Text color="gray">↑/↓ select, s start, x stop, f refresh</Text>
                        {triggerRows.slice(0, 30).map((entry, idx) => {
                            const selected = idx === selectedTriggerIndex;
                            const key = String(entry?.id || idx);
                            return (
                                <Text key={key} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {String(entry?.kind || '?')} {String(entry?.pipelineName || '-')}::{String(entry?.stepId || '-')}
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="55%" borderStyle="round" borderColor="yellow" paddingX={1}>
                        <Text color="yellowBright">{sectionTitle('Selected Trigger')}</Text>
                        <Text>id: {String(selectedTrigger?.id || '-')}</Text>
                        <Text>intent: {String(selectedTrigger?.intent || '-')}</Text>
                        <Text>enabled: {String(selectedTrigger?.enabled === true)}</Text>
                    </Box>
                </Box>
            )}

            {tab === 'hitl' && (
                <Box marginTop={1}>
                    <Box flexDirection="column" width="45%" borderStyle="round" borderColor="green" paddingX={1} marginRight={1}>
                        <Text color="greenBright">{sectionTitle(`Approvals (${approvals.length})`)}</Text>
                        <Text color="gray">↑/↓ select, a approve, r reject</Text>
                        {approvals.slice(0, 30).map((entry, idx) => {
                            const selected = idx === selectedApprovalIndex;
                            const key = String(entry?.id || idx);
                            return (
                                <Text key={key} color={selected ? 'magentaBright' : undefined}>
                                    {selected ? '>' : ' '} {String(entry?.runId || '?')}::{String(entry?.nodeId || '-')}
                                </Text>
                            );
                        })}
                    </Box>
                    <Box flexDirection="column" width="55%" borderStyle="round" borderColor="yellow" paddingX={1}>
                        <Text color="yellowBright">{sectionTitle('Selected Approval')}</Text>
                        <Text>id: {String(selectedApproval?.id || '-')}</Text>
                        <Text>prompt: {String(selectedApproval?.prompt || '-')}</Text>
                        <Text>source: {String(selectedApproval?.source || '-')}</Text>
                    </Box>
                </Box>
            )}

            <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
                <Text color="yellow">{statusLine}</Text>
                <Text> </Text>
                <Text color="gray">Keys: 1..7 tabs, q quit</Text>
            </Box>

            {promptOpen && (
                <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
                    <Text color="yellowBright">{promptTitle}: </Text>
                    <Text color="white">{promptValue}</Text>
                    <Text color="gray"> (Enter confirm, Esc cancel)</Text>
                </Box>
            )}
        </Box>
    );
}
