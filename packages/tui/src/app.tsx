import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { LegacyApp } from './legacyApp';
import { loadTuiConfig } from './state/config';
import { defaultFocusForTab, resolveGlobalKeyAction } from './state/keymap';
import { TAB_SHORTCUTS, createInitialUiState, uiReducer } from './state/machines';
import { rankPaletteItems } from './state/palette';
import { CommandPaletteItem, TabId, TuiRuntimeConfig } from './state/types';
import {
    buildActionNodeYaml,
    buildAddNodeTemplate,
    buildPipelineYaml,
    editTextWithEditor,
    generatePipelineName,
    NODE_TEMPLATE_HINT,
    normalizeNodeTemplateKey,
    resolveEditorCommand
} from './services/editorYaml';
import {
    boundedAppend,
    formatEventLine,
    formatTime,
    tailWindow,
    tryExtractLogLine
} from './services/formatters';
import { DiffScreen } from './screens/diffScreen';
import { EditorScreen } from './screens/editorScreen';
import { HistoryScreen } from './screens/historyScreen';
import { HitlScreen } from './screens/hitlScreen';
import { PipelinesScreen } from './screens/pipelinesScreen';
import { RunScreen } from './screens/runScreen';
import { TriggersScreen } from './screens/triggersScreen';
import { CommandPalette } from './ui/palette';
import { Footer, Header, TabBar } from './ui/primitives';
import { ConfirmOverlay, HelpOverlay, PromptOverlay } from './ui/overlays';
import { createTheme } from './ui/theme';

const core: any = require('../../core/out/index');

type AppProps = {
    workspaceRoot: string;
    initialRunId?: string;
    initialPipeline?: string;
    legacyMode?: boolean;
};

type ModernAppProps = {
    workspaceRoot: string;
    initialRunId?: string;
    initialPipeline?: string;
    config: TuiRuntimeConfig;
};

function toUpperSafe(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function ensureIndex(index: number, size: number): number {
    if (size <= 0) return 0;
    if (index < 0) return 0;
    if (index >= size) return size - 1;
    return index;
}

export function App(props: AppProps): JSX.Element {
    const config = useMemo(() => loadTuiConfig(props.workspaceRoot), [props.workspaceRoot]);
    const useLegacy = props.legacyMode === true || config.ui.version === 'legacy';

    if (useLegacy) {
        return (
            <LegacyApp
                workspaceRoot={props.workspaceRoot}
                initialRunId={props.initialRunId}
                initialPipeline={props.initialPipeline}
            />
        );
    }

    return (
        <ModernApp
            workspaceRoot={props.workspaceRoot}
            initialRunId={props.initialRunId}
            initialPipeline={props.initialPipeline}
            config={config}
        />
    );
}

function ModernApp(props: ModernAppProps): JSX.Element {
    const { exit } = useApp();
    const [ui, dispatch] = useReducer(uiReducer, undefined, createInitialUiState);
    const [runs, setRuns] = useState<any[]>([]);
    const [pipelines, setPipelines] = useState<any[]>([]);
    const [editorNodes, setEditorNodes] = useState<any[]>([]);
    const [historyRows, setHistoryRows] = useState<any[]>([]);
    const [triggerRows, setTriggerRows] = useState<any[]>([]);
    const [approvals, setApprovals] = useState<any[]>([]);
    const [diffLines, setDiffLines] = useState<string[]>([]);
    const [diffSource, setDiffSource] = useState<'audit' | 'git' | 'none'>('none');
    const [eventLines, setEventLines] = useState<string[]>([]);
    const [logLines, setLogLines] = useState<string[]>([]);

    const promptSubmitRef = useRef<((value: string) => void) | null>(null);
    const confirmHandlerRef = useRef<Record<string, (() => void) | undefined>>({});
    const selectedRunCursorRef = useRef<number>(0);
    const selectedRunIdRef = useRef<string>('');
    const pollRef = useRef<Record<string, number>>({});
    const initialRunAppliedRef = useRef<boolean>(false);
    const initialPipelineAppliedRef = useRef<boolean>(false);

    const theme = useMemo(() => createTheme(props.config.theme.highContrast), [props.config.theme.highContrast]);

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

    const selectedRun = runs[ui.selectedRunIndex];
    const selectedRunId = String(selectedRun?.detachedRunId || selectedRun?.pipelineRunId || '').trim();
    const selectedPipeline = pipelines[ui.selectedPipelineIndex];
    const selectedEditorNode = editorNodes[ui.selectedEditorNodeIndex];
    const selectedHistory = historyRows[ui.selectedHistoryIndex];
    const selectedTrigger = triggerRows[ui.selectedTriggerIndex];
    const selectedApproval = approvals[ui.selectedApprovalIndex];

    const visibleEvents = useMemo(() => tailWindow(eventLines, 22, ui.eventOffset), [eventLines, ui.eventOffset]);
    const visibleLogs = useMemo(() => tailWindow(logLines, 12, ui.logOffset), [logLines, ui.logOffset]);

    const yamlPreview = useMemo(() => {
        if (!selectedEditorNode) return [];
        try {
            return buildActionNodeYaml(selectedEditorNode).split('\n');
        } catch {
            return [];
        }
    }, [selectedEditorNode]);

    const setStatus = useCallback((text: string, tone: 'ok' | 'warn' | 'err' | 'info' | 'muted' = 'info') => {
        dispatch({ type: 'set_status', text, tone });
    }, []);

    const openPrompt = useCallback((title: string, initialValue: string, onSubmit: (value: string) => void, description?: string) => {
        promptSubmitRef.current = onSubmit;
        dispatch({ type: 'open_prompt', title, value: initialValue, description });
    }, []);

    const openConfirm = useCallback((title: string, body: string, onConfirm: () => void) => {
        const actionKey = `confirm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        confirmHandlerRef.current[actionKey] = onConfirm;
        dispatch({ type: 'open_confirm', title, body, actionKey });
    }, []);

    const refreshRuns = useCallback(() => {
        try {
            const rows = supervisor.list_runs();
            setRuns(rows);

            if (rows.length === 0) {
                dispatch({ type: 'select_index', key: 'run', index: 0, max: 0 });
                return;
            }

            if (!initialRunAppliedRef.current && props.initialRunId) {
                const index = rows.findIndex((entry: any) => {
                    return String(entry?.detachedRunId || '') === props.initialRunId
                        || String(entry?.pipelineRunId || '') === props.initialRunId;
                });
                if (index >= 0) {
                    dispatch({ type: 'select_index', key: 'run', index, max: rows.length });
                    initialRunAppliedRef.current = true;
                    return;
                }
                initialRunAppliedRef.current = true;
            }

            dispatch({ type: 'select_index', key: 'run', index: ui.selectedRunIndex, max: rows.length });
        } catch (error: any) {
            setStatus(`Refresh runs échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [props.initialRunId, setStatus, supervisor, ui.selectedRunIndex]);

    const refreshPipelines = useCallback(() => {
        try {
            const rows = catalog.list();
            setPipelines(rows);

            if (rows.length === 0) {
                dispatch({ type: 'select_index', key: 'pipeline', index: 0, max: 0 });
                return;
            }

            if (!initialPipelineAppliedRef.current && props.initialPipeline) {
                const index = rows.findIndex((entry: any) => {
                    return String(entry?.name || '') === props.initialPipeline
                        || String(entry?.path || '') === props.initialPipeline;
                });
                if (index >= 0) {
                    dispatch({ type: 'select_index', key: 'pipeline', index, max: rows.length });
                    initialPipelineAppliedRef.current = true;
                    return;
                }
                initialPipelineAppliedRef.current = true;
            }

            dispatch({ type: 'select_index', key: 'pipeline', index: ui.selectedPipelineIndex, max: rows.length });
        } catch (error: any) {
            setStatus(`Refresh pipelines échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [catalog, props.initialPipeline, setStatus, ui.selectedPipelineIndex]);

    const refreshEditorNodes = useCallback(() => {
        const pipelinePath = String(pipelines[ui.selectedPipelineIndex]?.path || '').trim();
        if (!pipelinePath) {
            setEditorNodes([]);
            dispatch({ type: 'select_index', key: 'editor', index: 0, max: 0 });
            return;
        }

        try {
            const pipeline = catalog.load(pipelinePath);
            const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
            setEditorNodes(steps);
            dispatch({ type: 'select_index', key: 'editor', index: ui.selectedEditorNodeIndex, max: steps.length });
        } catch (error: any) {
            setStatus(`Refresh editor échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [catalog, pipelines, setStatus, ui.selectedEditorNodeIndex, ui.selectedPipelineIndex]);

    const refreshHistory = useCallback(async () => {
        try {
            const rows = await historyService.list();
            const safeRows = Array.isArray(rows) ? rows : [];
            setHistoryRows(safeRows);
            dispatch({ type: 'select_index', key: 'history', index: ui.selectedHistoryIndex, max: safeRows.length });
        } catch (error: any) {
            setStatus(`Refresh history échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [historyService, setStatus, ui.selectedHistoryIndex]);

    const refreshTriggers = useCallback(() => {
        try {
            const rows = triggerService.list();
            setTriggerRows(rows);
            dispatch({ type: 'select_index', key: 'trigger', index: ui.selectedTriggerIndex, max: rows.length });
        } catch (error: any) {
            setStatus(`Refresh triggers échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [setStatus, triggerService, ui.selectedTriggerIndex]);

    const refreshApprovals = useCallback(() => {
        try {
            const rows = approvalService.list_pending();
            setApprovals(rows);
            dispatch({ type: 'select_index', key: 'approval', index: ui.selectedApprovalIndex, max: rows.length });
        } catch (error: any) {
            setStatus(`Refresh HITL échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [approvalService, setStatus, ui.selectedApprovalIndex]);

    const refreshDiff = useCallback(async () => {
        const runId = String(historyRows[ui.selectedHistoryIndex]?.id || '').trim();
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
            setStatus(`Refresh diff échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [diffService, historyRows, setStatus, ui.selectedHistoryIndex]);

    const tailSelectedRun = useCallback(() => {
        if (!selectedRunId) return;
        try {
            const tail = supervisor.tail_events(selectedRunId, selectedRunCursorRef.current);
            selectedRunCursorRef.current = tail.nextCursor;
            if (!Array.isArray(tail.events) || tail.events.length === 0) {
                return;
            }
            const nextEventLines = tail.events.map((event: any) => formatEventLine(event));
            const nextLogLines = tail.events
                .map((event: any) => tryExtractLogLine(event))
                .filter((entry: string | undefined): entry is string => Boolean(entry));

            setEventLines((previous) => boundedAppend(previous, nextEventLines, props.config.maxEvents));
            if (nextLogLines.length > 0) {
                setLogLines((previous) => boundedAppend(previous, nextLogLines, props.config.maxLogs));
            }
        } catch {
            // ignore short race conditions during run lifecycle
        }
    }, [props.config.maxEvents, props.config.maxLogs, selectedRunId, supervisor]);

    const replaceSelectedNodeFromYaml = useCallback((yamlPayload: string) => {
        const pipelinePath = String(pipelines[ui.selectedPipelineIndex]?.path || '').trim();
        if (!pipelinePath) {
            setStatus('Aucun pipeline sélectionné pour cette action.', 'warn');
            return;
        }
        try {
            dslService.replace_node(pipelinePath, yamlPayload);
            refreshEditorNodes();
            refreshPipelines();
            setStatus('Node mis à jour.', 'ok');
        } catch (error: any) {
            setStatus(`Replace node échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [dslService, pipelines, refreshEditorNodes, refreshPipelines, setStatus, ui.selectedPipelineIndex]);

    const patchSelectedNode = useCallback((patch: { intent?: string; description?: string; onFailure?: string; payload?: any }) => {
        if (!selectedEditorNode) {
            setStatus('Aucun node sélectionné.', 'warn');
            return;
        }
        const yamlPayload = buildActionNodeYaml(selectedEditorNode, patch);
        replaceSelectedNodeFromYaml(yamlPayload);
    }, [replaceSelectedNodeFromYaml, selectedEditorNode, setStatus]);

    const startDetachedPipeline = useCallback((entry: any) => {
        try {
            const out = supervisor.start_detached({
                pipeline: String(entry?.path || entry?.name || ''),
                dryRun: false
            });
            setStatus(`Run detached démarré: ${String(out?.run_id || '-')}`, 'ok');
            refreshRuns();
        } catch (error: any) {
            setStatus(`Run detached échoué: ${String(error?.message || error)}`, 'err');
        }
    }, [refreshRuns, setStatus, supervisor]);

    const executePaletteAction = useCallback((item: CommandPaletteItem) => {
        if (item.id === 'action:refresh') {
            refreshRuns();
            refreshPipelines();
            refreshEditorNodes();
            void refreshHistory();
            refreshTriggers();
            refreshApprovals();
            void refreshDiff();
            setStatus('Refresh global exécuté.', 'ok');
            return;
        }
        if (item.id === 'action:theme-toggle') {
            setStatus('Mode high-contrast se configure via intentRouter.tui.theme.highContrast.', 'info');
            return;
        }
        if (item.id === 'action:legacy') {
            setStatus('Relance: leion-roots tui --legacy', 'info');
            return;
        }

        dispatch(item.event);
        if (item.followUpEvent) {
            dispatch(item.followUpEvent);
        }
    }, [refreshApprovals, refreshDiff, refreshEditorNodes, refreshPipelines, refreshRuns, refreshTriggers, refreshHistory, setStatus]);

    const moveByFocus = useCallback((delta: number) => {
        if (ui.activeTab === 'run') {
            if (ui.focusZone === 'left') {
                dispatch({ type: 'move_index', key: 'run', delta, max: runs.length });
                return;
            }
            if (ui.focusZone === 'center') {
                dispatch({ type: 'scroll_events', delta: -delta * 5 });
                return;
            }
            if (ui.focusZone === 'right') {
                dispatch({ type: 'scroll_logs', delta: -delta * 5 });
                return;
            }
            return;
        }

        if (ui.activeTab === 'pipelines') {
            dispatch({ type: 'move_index', key: 'pipeline', delta, max: pipelines.length });
            return;
        }

        if (ui.activeTab === 'editor') {
            dispatch({ type: 'move_index', key: 'editor', delta, max: editorNodes.length });
            return;
        }

        if (ui.activeTab === 'history') {
            dispatch({ type: 'move_index', key: 'history', delta, max: historyRows.length });
            return;
        }

        if (ui.activeTab === 'triggers') {
            dispatch({ type: 'move_index', key: 'trigger', delta, max: triggerRows.length });
            return;
        }

        if (ui.activeTab === 'hitl') {
            dispatch({ type: 'move_index', key: 'approval', delta, max: approvals.length });
        }
    }, [approvals.length, editorNodes.length, historyRows.length, pipelines.length, runs.length, triggerRows.length, ui.activeTab, ui.focusZone]);

    useEffect(() => {
        refreshRuns();
        refreshPipelines();
        refreshEditorNodes();
        void refreshHistory();
        refreshTriggers();
        refreshApprovals();
        void refreshDiff();
        // Intentionally bootstrap once; periodic scheduler handles subsequent refresh cycles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (selectedRunId && selectedRunIdRef.current !== selectedRunId) {
            selectedRunIdRef.current = selectedRunId;
            selectedRunCursorRef.current = 0;
            setEventLines([]);
            setLogLines([]);
            dispatch({ type: 'scroll_events', delta: -999999 });
            dispatch({ type: 'scroll_logs', delta: -999999 });
        }
    }, [selectedRunId]);

    useEffect(() => {
        const timer = setInterval(() => {
            const now = Date.now();
            const active = ui.activeTab;

            const every = (key: string, ms: number, fn: () => void) => {
                const last = pollRef.current[key] || 0;
                if (now - last >= ms) {
                    pollRef.current[key] = now;
                    fn();
                }
            };

            every('runs', active === 'run' ? 700 : 1400, refreshRuns);
            every('pipelines', active === 'pipelines' || active === 'editor' ? 900 : 2000, refreshPipelines);
            every('editor', active === 'editor' ? 900 : 2500, refreshEditorNodes);
            every('history', active === 'history' || active === 'diff' ? 1300 : 2600, () => void refreshHistory());
            every('diff', active === 'diff' ? 1100 : 2600, () => void refreshDiff());
            every('triggers', active === 'triggers' ? 1200 : 2500, refreshTriggers);
            every('hitl', active === 'hitl' ? 1000 : 2200, refreshApprovals);
            every('events', active === 'run' ? 250 : 700, tailSelectedRun);
        }, 200);

        return () => clearInterval(timer);
    }, [
        refreshApprovals,
        refreshDiff,
        refreshEditorNodes,
        refreshHistory,
        refreshPipelines,
        refreshRuns,
        refreshTriggers,
        tailSelectedRun,
        ui.activeTab
    ]);

    useEffect(() => {
        return () => {
            approvalService.dispose();
            void runtime.stop_triggers();
        };
    }, [approvalService, runtime]);

    const paletteItems = useMemo(() => {
        const items: CommandPaletteItem[] = [
            {
                id: 'action:refresh',
                label: 'Refresh global data',
                hint: 'action',
                category: 'action',
                keywords: ['refresh', 'reload', 'sync'],
                event: { type: 'set_status', text: 'Refresh en cours...', tone: 'info' }
            },
            {
                id: 'action:legacy',
                label: 'Afficher fallback legacy',
                hint: 'action',
                category: 'action',
                keywords: ['legacy', 'fallback', 'rollback'],
                event: { type: 'set_status', text: 'Legacy mode info', tone: 'info' }
            },
            {
                id: 'action:theme-toggle',
                label: 'Info mode high-contrast',
                hint: 'action',
                category: 'action',
                keywords: ['contrast', 'theme', 'accessibility'],
                event: { type: 'set_status', text: 'Theme info', tone: 'info' }
            }
        ];

        for (const [key, tab] of Object.entries(TAB_SHORTCUTS)) {
            items.push({
                id: `tab:${tab}`,
                label: `Aller vers ${tab}`,
                hint: `tab ${key}`,
                category: 'tab',
                keywords: [tab, 'tab', key],
                event: { type: 'switch_tab', tab }
            });
        }

        runs.slice(0, 20).forEach((entry, index) => {
            const runId = String(entry?.detachedRunId || entry?.pipelineRunId || `run_${index}`);
            items.push({
                id: `entity:run:${index}`,
                label: `Run ${runId}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['run', runId, String(entry?.status || '-')],
                event: { type: 'switch_tab', tab: 'run' },
                followUpEvent: { type: 'select_index', key: 'run', index, max: runs.length }
            });
        });

        pipelines.slice(0, 20).forEach((entry, index) => {
            const label = String(entry?.name || `pipeline_${index}`);
            items.push({
                id: `entity:pipeline:${index}`,
                label: `Pipeline ${label}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['pipeline', label, String(entry?.path || '')],
                event: { type: 'switch_tab', tab: 'pipelines' },
                followUpEvent: { type: 'select_index', key: 'pipeline', index, max: pipelines.length }
            });
        });

        editorNodes.slice(0, 20).forEach((entry, index) => {
            const label = String(entry?.id || `node_${index}`);
            items.push({
                id: `entity:node:${index}`,
                label: `Node ${label}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['node', label, String(entry?.intent || '')],
                event: { type: 'switch_tab', tab: 'editor' },
                followUpEvent: { type: 'select_index', key: 'editor', index, max: editorNodes.length }
            });
        });

        historyRows.slice(0, 20).forEach((entry, index) => {
            const label = String(entry?.id || `history_${index}`);
            items.push({
                id: `entity:history:${index}`,
                label: `History ${label}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['history', label, String(entry?.status || '')],
                event: { type: 'switch_tab', tab: 'history' },
                followUpEvent: { type: 'select_index', key: 'history', index, max: historyRows.length }
            });
        });

        triggerRows.slice(0, 20).forEach((entry, index) => {
            const label = String(entry?.id || `trigger_${index}`);
            items.push({
                id: `entity:trigger:${index}`,
                label: `Trigger ${label}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['trigger', label, String(entry?.pipelineName || '')],
                event: { type: 'switch_tab', tab: 'triggers' },
                followUpEvent: { type: 'select_index', key: 'trigger', index, max: triggerRows.length }
            });
        });

        approvals.slice(0, 20).forEach((entry, index) => {
            const label = String(entry?.id || `approval_${index}`);
            items.push({
                id: `entity:approval:${index}`,
                label: `Approval ${label}`,
                hint: 'entity',
                category: 'entity',
                keywords: ['hitl', 'approval', label, String(entry?.runId || '')],
                event: { type: 'switch_tab', tab: 'hitl' },
                followUpEvent: { type: 'select_index', key: 'approval', index, max: approvals.length }
            });
        });

        return items;
    }, [approvals, editorNodes, historyRows, pipelines, runs, triggerRows]);

    const rankedPaletteItems = useMemo(() => {
        return rankPaletteItems(paletteItems, ui.palette.query, 30);
    }, [paletteItems, ui.palette.query]);

    const applyTabAction = useCallback((input: string, key: any) => {
        if (ui.activeTab === 'run') {
            if (input === '[') {
                dispatch({ type: 'scroll_events', delta: 25 });
                return;
            }
            if (input === ']') {
                dispatch({ type: 'scroll_events', delta: -25 });
                return;
            }
            if (input === '{') {
                dispatch({ type: 'scroll_logs', delta: 25 });
                return;
            }
            if (input === '}') {
                dispatch({ type: 'scroll_logs', delta: -25 });
                return;
            }
            if (input === 'l') {
                refreshRuns();
                setStatus('Runs refresh demandée.', 'ok');
                return;
            }
            if (input === 'p' && selectedRunId) {
                try {
                    supervisor.pause_run(selectedRunId);
                    setStatus(`Pause demandée pour ${selectedRunId}`, 'warn');
                } catch (error: any) {
                    setStatus(`Pause échouée: ${String(error?.message || error)}`, 'err');
                }
                return;
            }
            if (input === 'r' && selectedRunId) {
                try {
                    supervisor.resume_run(selectedRunId);
                    setStatus(`Resume demandée pour ${selectedRunId}`, 'ok');
                } catch (error: any) {
                    setStatus(`Resume échouée: ${String(error?.message || error)}`, 'err');
                }
                return;
            }
            if (input === 'c' && selectedRunId) {
                openConfirm(
                    'Confirmer cancel run',
                    `Annuler définitivement le run ${selectedRunId} ?`,
                    () => {
                        try {
                            supervisor.cancel_run(selectedRunId);
                            setStatus(`Cancel demandé pour ${selectedRunId}`, 'warn');
                        } catch (error: any) {
                            setStatus(`Cancel échoué: ${String(error?.message || error)}`, 'err');
                        }
                    }
                );
            }
            return;
        }

        if (ui.activeTab === 'pipelines') {
            const selected = pipelines[ui.selectedPipelineIndex];
            if ((key.return || input === 'r') && selected) {
                startDetachedPipeline(selected);
                return;
            }
            if (input === 'd' && selected) {
                void runtime.run_pipeline_file(String(selected.path || ''), { dryRun: true })
                    .then((result: any) => {
                        setStatus(`Dry-run ${result?.success ? 'ok' : 'failed'} (${String(result?.runId || '-')})`, result?.success ? 'ok' : 'warn');
                    })
                    .catch((error: any) => {
                        setStatus(`Dry-run échoué: ${String(error?.message || error)}`, 'err');
                    });
                return;
            }
            if (input === 'n') {
                const name = generatePipelineName();
                try {
                    catalog.create(name);
                    refreshPipelines();
                    setStatus(`Pipeline créé: ${name}`, 'ok');
                } catch (error: any) {
                    setStatus(`Création échouée: ${String(error?.message || error)}`, 'err');
                }
                return;
            }
            if (input === 'x' && selected) {
                openConfirm(
                    'Confirmer suppression pipeline',
                    `Supprimer ${String(selected?.name || selected?.path || '?')} ?`,
                    () => {
                        try {
                            catalog.delete(String(selected.path || selected.name || ''));
                            refreshPipelines();
                            refreshEditorNodes();
                            setStatus(`Pipeline supprimé: ${String(selected?.name || '-')}`, 'warn');
                        } catch (error: any) {
                            setStatus(`Suppression échouée: ${String(error?.message || error)}`, 'err');
                        }
                    }
                );
                return;
            }
            if (input === 'e') {
                dispatch({ type: 'switch_tab', tab: 'editor' });
                dispatch({ type: 'set_focus', zone: defaultFocusForTab('editor') });
            }
            return;
        }

        if (ui.activeTab === 'editor') {
            const pipelinePath = String(pipelines[ui.selectedPipelineIndex]?.path || '').trim();
            if (!pipelinePath) return;

            if (input === 'u' && editorNodes.length > 1) {
                const ids = editorNodes.map((entry: any) => String(entry?.id || '').trim()).filter(Boolean);
                const index = ui.selectedEditorNodeIndex;
                if (index > 0) {
                    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                    try {
                        dslService.reorder_nodes(pipelinePath, ids);
                        dispatch({ type: 'select_index', key: 'editor', index: index - 1, max: ids.length });
                        refreshEditorNodes();
                        refreshPipelines();
                        setStatus('Node déplacé vers le haut.', 'ok');
                    } catch (error: any) {
                        setStatus(`Reorder échoué: ${String(error?.message || error)}`, 'err');
                    }
                }
                return;
            }

            if (input === 'j' && editorNodes.length > 1 && ui.focusZone !== 'left') {
                // j reste disponible en mode hybrid pour move list; on réserve ici j-reorder seulement hors focus liste
                const ids = editorNodes.map((entry: any) => String(entry?.id || '').trim()).filter(Boolean);
                const index = ui.selectedEditorNodeIndex;
                if (index < ids.length - 1) {
                    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                    try {
                        dslService.reorder_nodes(pipelinePath, ids);
                        dispatch({ type: 'select_index', key: 'editor', index: index + 1, max: ids.length });
                        refreshEditorNodes();
                        refreshPipelines();
                        setStatus('Node déplacé vers le bas.', 'ok');
                    } catch (error: any) {
                        setStatus(`Reorder échoué: ${String(error?.message || error)}`, 'err');
                    }
                }
                return;
            }

            if (input === 'x' && selectedEditorNode) {
                const nodeId = String(selectedEditorNode?.id || '').trim();
                if (!nodeId) return;
                openConfirm(
                    'Confirmer suppression node',
                    `Supprimer node ${nodeId} ?`,
                    () => {
                        try {
                            dslService.delete_node(pipelinePath, nodeId);
                            refreshEditorNodes();
                            refreshPipelines();
                            setStatus(`Node supprimé: ${nodeId}`, 'warn');
                        } catch (error: any) {
                            setStatus(`Suppression node échouée: ${String(error?.message || error)}`, 'err');
                        }
                    }
                );
                return;
            }

            if (input === 'a') {
                openPrompt(
                    `Ajouter node type (${NODE_TEMPLATE_HINT})`,
                    'action',
                    (value) => {
                        const template = normalizeNodeTemplateKey(value);
                        if (!template) {
                            setStatus(`Type inconnu: ${value}`, 'warn');
                            return;
                        }
                        const nextId = `${template.replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36).slice(-6)}`;
                        const yamlPayload = buildAddNodeTemplate(template, nextId);
                        setStatus(`Ouverture template ${template} dans $EDITOR...`, 'info');
                        const edited = editTextWithEditor(yamlPayload);
                        if (!edited.ok || !edited.text) {
                            setStatus(edited.error || 'Édition YAML annulée.', 'warn');
                            return;
                        }
                        try {
                            dslService.add_node(pipelinePath, edited.text);
                            refreshEditorNodes();
                            refreshPipelines();
                            setStatus(`Node ajouté (${template}).`, 'ok');
                        } catch (error: any) {
                            setStatus(`Ajout node échoué: ${String(error?.message || error)}`, 'err');
                        }
                    },
                    'Catalogue: action|script|http|prompt|form|switch|repo|sub_pipeline|loop|agent|team|memory_save|memory_recall|memory_clear'
                );
                return;
            }

            if (input === 'v') {
                try {
                    const pipeline = catalog.load(pipelinePath);
                    const yamlPayload = buildPipelineYaml(pipeline);
                    const edited = editTextWithEditor(yamlPayload);
                    if (!edited.ok || !edited.text) {
                        setStatus(edited.error || 'Édition YAML pipeline annulée.', 'warn');
                        return;
                    }
                    dslService.edit_pipeline(pipelinePath, edited.text);
                    refreshEditorNodes();
                    refreshPipelines();
                    setStatus('Pipeline YAML mis à jour.', 'ok');
                } catch (error: any) {
                    setStatus(`Édition pipeline échouée: ${String(error?.message || error)}`, 'err');
                }
                return;
            }

            if (input === 'i' && selectedEditorNode) {
                openPrompt('Set intent', String(selectedEditorNode.intent || ''), (value) => {
                    patchSelectedNode({ intent: String(value || '').trim() });
                }, 'Champ technique: intent EN');
                return;
            }

            if (input === 'm' && selectedEditorNode) {
                openPrompt('Set description', String(selectedEditorNode.description || ''), (value) => {
                    patchSelectedNode({ description: String(value || '') });
                });
                return;
            }

            if (input === 'o' && selectedEditorNode) {
                openPrompt('Set on_failure', String(selectedEditorNode.onFailure || ''), (value) => {
                    patchSelectedNode({ onFailure: String(value || '') });
                });
                return;
            }

            if (input === 'c' && selectedEditorNode) {
                const payload = selectedEditorNode.payload && typeof selectedEditorNode.payload === 'object'
                    ? selectedEditorNode.payload
                    : {};
                openPrompt('Set payload.command', String(payload.command || ''), (value) => {
                    patchSelectedNode({ payload: { ...payload, command: String(value || '') } });
                });
                return;
            }

            if (input === 'y' && selectedEditorNode) {
                const yamlPayload = buildActionNodeYaml(selectedEditorNode);
                const edited = editTextWithEditor(yamlPayload);
                if (!edited.ok || !edited.text) {
                    setStatus(edited.error || 'Édition YAML node annulée.', 'warn');
                    return;
                }
                replaceSelectedNodeFromYaml(edited.text);
            }
            return;
        }

        if (ui.activeTab === 'diff') {
            if (input === 'f') {
                void refreshDiff();
                setStatus('Diff refresh demandée.', 'ok');
            }
            return;
        }

        if (ui.activeTab === 'triggers') {
            if (input === 's') {
                void triggerService.start()
                    .then(() => setStatus('Triggers démarrés.', 'ok'))
                    .catch((error: any) => setStatus(`Start triggers échoué: ${String(error?.message || error)}`, 'err'));
                return;
            }
            if (input === 'x') {
                void triggerService.stop()
                    .then(() => setStatus('Triggers stoppés.', 'warn'))
                    .catch((error: any) => setStatus(`Stop triggers échoué: ${String(error?.message || error)}`, 'err'));
                return;
            }
            if (input === 'f') {
                void triggerService.refresh()
                    .then(() => {
                        refreshTriggers();
                        setStatus('Triggers refresh exécuté.', 'ok');
                    })
                    .catch((error: any) => setStatus(`Refresh triggers échoué: ${String(error?.message || error)}`, 'err'));
            }
            return;
        }

        if (ui.activeTab === 'hitl') {
            if (!selectedApproval) return;
            if (input === 'a') {
                try {
                    approvalService.resolve({ pendingId: selectedApproval.id, decision: 'approve' });
                    refreshApprovals();
                    setStatus(`Approval accepté: ${String(selectedApproval.id)}`, 'ok');
                } catch (error: any) {
                    setStatus(`Approve échoué: ${String(error?.message || error)}`, 'err');
                }
                return;
            }
            if (input === 'r') {
                openConfirm(
                    'Confirmer reject approval',
                    `Reject ${String(selectedApproval.id)} ?`,
                    () => {
                        try {
                            approvalService.resolve({ pendingId: selectedApproval.id, decision: 'reject' });
                            refreshApprovals();
                            setStatus(`Approval rejeté: ${String(selectedApproval.id)}`, 'warn');
                        } catch (error: any) {
                            setStatus(`Reject échoué: ${String(error?.message || error)}`, 'err');
                        }
                    }
                );
            }
        }
    }, [
        approvalService,
        catalog,
        dslService,
        editorNodes,
        openConfirm,
        openPrompt,
        patchSelectedNode,
        pipelines,
        refreshApprovals,
        refreshDiff,
        refreshEditorNodes,
        refreshPipelines,
        refreshRuns,
        refreshTriggers,
        replaceSelectedNodeFromYaml,
        runtime,
        selectedApproval,
        selectedEditorNode,
        selectedRunId,
        setStatus,
        startDetachedPipeline,
        supervisor,
        triggerService,
        ui.activeTab,
        ui.focusZone,
        ui.selectedEditorNodeIndex,
        ui.selectedPipelineIndex
    ]);

    useInput((input, key) => {
        if (ui.confirm.open) {
            const action = resolveGlobalKeyAction(input, key, props.config.keymap.profile, props.config.palette.enabled);
            if (action.type === 'cancel') {
                dispatch({ type: 'close_confirm' });
                setStatus('Confirmation annulée.', 'warn');
                return;
            }
            if (action.type === 'confirm') {
                const handler = confirmHandlerRef.current[ui.confirm.actionKey];
                if (handler) {
                    handler();
                }
                delete confirmHandlerRef.current[ui.confirm.actionKey];
                dispatch({ type: 'close_confirm' });
                return;
            }
            return;
        }

        if (ui.prompt.open) {
            const action = resolveGlobalKeyAction(input, key, props.config.keymap.profile, props.config.palette.enabled);
            if (action.type === 'cancel') {
                dispatch({ type: 'close_prompt' });
                promptSubmitRef.current = null;
                setStatus('Prompt annulé.', 'warn');
                return;
            }
            if (action.type === 'confirm') {
                const callback = promptSubmitRef.current;
                const value = ui.prompt.value;
                dispatch({ type: 'close_prompt' });
                promptSubmitRef.current = null;
                if (callback) callback(value);
                return;
            }
            if (action.type === 'backspace') {
                dispatch({ type: 'prompt_set', value: ui.prompt.value.slice(0, -1) });
                return;
            }
            if (action.type === 'input_char') {
                dispatch({ type: 'prompt_set', value: `${ui.prompt.value}${action.value}` });
            }
            return;
        }

        if (ui.palette.open) {
            const action = resolveGlobalKeyAction(input, key, props.config.keymap.profile, props.config.palette.enabled);
            if (action.type === 'cancel' || (action.type === 'open_palette')) {
                dispatch({ type: 'close_palette' });
                return;
            }
            if (action.type === 'move_up') {
                dispatch({ type: 'palette_move', delta: -1, max: rankedPaletteItems.length });
                return;
            }
            if (action.type === 'move_down') {
                dispatch({ type: 'palette_move', delta: 1, max: rankedPaletteItems.length });
                return;
            }
            if (action.type === 'confirm') {
                const item = rankedPaletteItems[ensureIndex(ui.palette.selectedIndex, rankedPaletteItems.length)];
                if (item) {
                    executePaletteAction(item);
                }
                dispatch({ type: 'close_palette' });
                return;
            }
            if (action.type === 'backspace') {
                dispatch({ type: 'palette_query', query: ui.palette.query.slice(0, -1) });
                return;
            }
            if (action.type === 'input_char') {
                dispatch({ type: 'palette_query', query: `${ui.palette.query}${action.value}` });
            }
            return;
        }

        if (ui.activeTab === 'editor' && input === 'j') {
            applyTabAction(input, key);
            return;
        }

        const action = resolveGlobalKeyAction(input, key, props.config.keymap.profile, props.config.palette.enabled);

        if (action.type === 'quit') {
            exit();
            return;
        }
        if (action.type === 'toggle_help') {
            dispatch({ type: 'toggle_help' });
            return;
        }
        if (action.type === 'open_palette') {
            dispatch({ type: 'open_palette' });
            return;
        }
        if (action.type === 'switch_tab') {
            dispatch({ type: 'switch_tab', tab: action.tab });
            dispatch({ type: 'set_focus', zone: defaultFocusForTab(action.tab) });
            return;
        }
        if (action.type === 'cycle_focus') {
            dispatch({ type: 'cycle_focus', reverse: action.reverse });
            return;
        }
        if (action.type === 'move_up') {
            moveByFocus(-1);
            return;
        }
        if (action.type === 'move_down') {
            moveByFocus(1);
            return;
        }

        applyTabAction(input, key);
    });

    const shellHelp = useMemo(() => {
        const prompt = ui.prompt.open ? 'PROMPT' : ui.confirm.open ? 'CONFIRM' : ui.palette.open ? 'PALETTE' : 'NORMAL';
        return `Mode ${prompt} | 1..7 tabs | Tab/Shift+Tab focus | Ctrl+K palette | ? help | editor: ${resolveEditorCommand()}`;
    }, [ui.confirm.open, ui.palette.open, ui.prompt.open]);

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header
                theme={theme}
                workspaceRoot={props.workspaceRoot}
                selectedRunId={selectedRunId}
                selectedRunStatus={String(selectedRun?.status || 'idle')}
                uiVersion={`v2 (${props.config.keymap.profile})`}
            />

            <TabBar activeTab={ui.activeTab} theme={theme} />

            {ui.activeTab === 'run' && (
                <RunScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    runs={runs}
                    selectedRunIndex={ui.selectedRunIndex}
                    visibleEvents={visibleEvents}
                    visibleLogs={visibleLogs}
                    eventTotal={eventLines.length}
                    eventMax={props.config.maxEvents}
                    logTotal={logLines.length}
                    logMax={props.config.maxLogs}
                    eventOffset={ui.eventOffset}
                    logOffset={ui.logOffset}
                />
            )}

            {ui.activeTab === 'pipelines' && (
                <PipelinesScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    pipelines={pipelines}
                    selectedPipelineIndex={ui.selectedPipelineIndex}
                />
            )}

            {ui.activeTab === 'editor' && (
                <EditorScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    pipelinePath={String(selectedPipeline?.path || '')}
                    nodes={editorNodes}
                    selectedNodeIndex={ui.selectedEditorNodeIndex}
                    yamlPreview={yamlPreview}
                />
            )}

            {ui.activeTab === 'history' && (
                <HistoryScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    historyRows={historyRows}
                    selectedHistoryIndex={ui.selectedHistoryIndex}
                />
            )}

            {ui.activeTab === 'diff' && (
                <DiffScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    source={diffSource}
                    lines={diffLines}
                />
            )}

            {ui.activeTab === 'triggers' && (
                <TriggersScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    triggerRows={triggerRows}
                    selectedTriggerIndex={ui.selectedTriggerIndex}
                />
            )}

            {ui.activeTab === 'hitl' && (
                <HitlScreen
                    theme={theme}
                    focusZone={ui.focusZone}
                    approvals={approvals}
                    selectedApprovalIndex={ui.selectedApprovalIndex}
                />
            )}

            <Footer
                theme={theme}
                statusText={`${theme.symbols.bullet} ${ui.status.text}`}
                tone={ui.status.tone}
                helpHint={shellHelp}
            />

            <Box marginTop={1}>
                <Text color={theme.colors.muted}>
                    Run actif: {selectedRunId || '-'} {theme.symbols.separator} Pipeline: {String(selectedPipeline?.name || '-')} {theme.symbols.separator} History: {String(selectedHistory?.id || '-')} {theme.symbols.separator} Trigger: {String(selectedTrigger?.id || '-')} {theme.symbols.separator} HITL: {String(selectedApproval?.id || '-')} {theme.symbols.separator} Heure: {formatTime(Date.now())} {theme.symbols.separator} Status: {toUpperSafe(selectedRun?.status || 'idle')}
                </Text>
            </Box>

            {ui.showHelp && <HelpOverlay theme={theme} />}

            {ui.palette.open && (
                <CommandPalette
                    theme={theme}
                    query={ui.palette.query}
                    items={rankedPaletteItems}
                    selectedIndex={ensureIndex(ui.palette.selectedIndex, rankedPaletteItems.length)}
                />
            )}

            {ui.prompt.open && (
                <PromptOverlay
                    theme={theme}
                    title={ui.prompt.title}
                    value={ui.prompt.value}
                    description={ui.prompt.description}
                />
            )}

            {ui.confirm.open && (
                <ConfirmOverlay
                    theme={theme}
                    title={ui.confirm.title}
                    body={ui.confirm.body}
                />
            )}

            <Box marginTop={1}>
                <Text color={theme.colors.muted}>Config: intentRouter.tui.ui.version | theme.highContrast | keymap.profile | palette.enabled | palette.trigger</Text>
            </Box>
        </Box>
    );
}
