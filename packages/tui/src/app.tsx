import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { LegacyApp } from './legacyApp';
import { loadTuiConfig } from './state/config';
import { defaultFocusForTab, resolveGlobalKeyAction } from './state/keymap';
import { shiftTab, TAB_SHORTCUTS, createInitialUiState, uiReducer } from './state/machines';
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
import { boundaryWithinView, filterWithIndex, moveWithinView } from './services/filtering';
import { DiffScreen } from './screens/diffScreen';
import { EditorScreen } from './screens/editorScreen';
import { HistoryScreen } from './screens/historyScreen';
import { HitlScreen } from './screens/hitlScreen';
import { PipelinesScreen } from './screens/pipelinesScreen';
import { RunScreen } from './screens/runScreen';
import { TriggersScreen } from './screens/triggersScreen';
import { CommandPalette } from './ui/palette';
import { Footer, Header, KeybindStrip, TabBar } from './ui/primitives';
import { ConfirmOverlay, HelpOverlay, PromptOverlay } from './ui/overlays';
import { computeLayoutMode } from './ui/layout';
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

type FilterKey = 'run' | 'pipelines' | 'editor' | 'history' | 'diff' | 'triggers' | 'hitl';

function toUpperSafe(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function ensureIndex(index: number, size: number): number {
    if (size <= 0) return 0;
    if (index < 0) return 0;
    if (index >= size) return size - 1;
    return index;
}

function compactText(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input;
    if (maxChars <= 1) return input.slice(0, maxChars);
    return `${input.slice(0, Math.max(1, maxChars - 1))}…`;
}

function filterKeyForTab(tab: TabId): FilterKey {
    if (tab === 'run') return 'run';
    if (tab === 'pipelines') return 'pipelines';
    if (tab === 'editor') return 'editor';
    if (tab === 'history') return 'history';
    if (tab === 'diff') return 'diff';
    if (tab === 'triggers') return 'triggers';
    return 'hitl';
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
    const { stdout } = useStdout();
    const [stdoutColumns, setStdoutColumns] = useState<number>(Number(stdout?.columns || process.stdout.columns || 120));
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
    const [filters, setFilters] = useState<Record<FilterKey, string>>({
        run: '',
        pipelines: '',
        editor: '',
        history: '',
        diff: '',
        triggers: '',
        hitl: ''
    });

    const promptSubmitRef = useRef<((value: string) => void) | null>(null);
    const confirmHandlerRef = useRef<Record<string, (() => void) | undefined>>({});
    const selectedRunCursorRef = useRef<number>(0);
    const selectedRunIdRef = useRef<string>('');
    const pollRef = useRef<Record<string, number>>({});
    const initialRunAppliedRef = useRef<boolean>(false);
    const initialPipelineAppliedRef = useRef<boolean>(false);

    const theme = useMemo(() => createTheme(props.config.theme.highContrast), [props.config.theme.highContrast]);
    const layoutMode = useMemo(() => computeLayoutMode(stdoutColumns), [stdoutColumns]);

    useEffect(() => {
        const update = () => setStdoutColumns(Number(stdout?.columns || process.stdout.columns || 120));
        update();
        if (!stdout) return undefined;
        stdout.on('resize', update);
        return () => {
            if (typeof (stdout as any).off === 'function') {
                (stdout as any).off('resize', update);
            } else {
                stdout.removeListener('resize', update);
            }
        };
    }, [stdout]);

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

    const runView = useMemo(
        () => filterWithIndex(runs, filters.run, (row) => [row?.detachedRunId, row?.pipelineRunId, row?.status]),
        [filters.run, runs]
    );
    const pipelineView = useMemo(
        () => filterWithIndex(pipelines, filters.pipelines, (row) => [row?.name, row?.path]),
        [filters.pipelines, pipelines]
    );
    const editorView = useMemo(
        () => filterWithIndex(editorNodes, filters.editor, (row) => [row?.id, row?.type, row?.intent, row?.description, row?.onFailure, row?.payload]),
        [editorNodes, filters.editor]
    );
    const historyView = useMemo(
        () => filterWithIndex(historyRows, filters.history, (row) => [row?.id, row?.name, row?.status, row?.timestamp]),
        [filters.history, historyRows]
    );
    const triggerView = useMemo(
        () => filterWithIndex(triggerRows, filters.triggers, (row) => [row?.id, row?.kind, row?.pipelineName, row?.stepId, row?.intent]),
        [filters.triggers, triggerRows]
    );
    const approvalView = useMemo(
        () => filterWithIndex(approvals, filters.hitl, (row) => [row?.id, row?.runId, row?.nodeId, row?.prompt, row?.source]),
        [approvals, filters.hitl]
    );
    const diffViewLines = useMemo(() => {
        const query = filters.diff.trim().toLowerCase();
        if (!query) return diffLines;
        return diffLines.filter((line) => String(line || '').toLowerCase().includes(query));
    }, [diffLines, filters.diff]);

    const runViewIndices = useMemo(() => runView.map((entry) => entry.index), [runView]);
    const pipelineViewIndices = useMemo(() => pipelineView.map((entry) => entry.index), [pipelineView]);
    const editorViewIndices = useMemo(() => editorView.map((entry) => entry.index), [editorView]);
    const historyViewIndices = useMemo(() => historyView.map((entry) => entry.index), [historyView]);
    const triggerViewIndices = useMemo(() => triggerView.map((entry) => entry.index), [triggerView]);
    const approvalViewIndices = useMemo(() => approvalView.map((entry) => entry.index), [approvalView]);

    const runList = useMemo(() => runView.map((entry) => entry.row), [runView]);
    const pipelineList = useMemo(() => pipelineView.map((entry) => entry.row), [pipelineView]);
    const editorList = useMemo(() => editorView.map((entry) => entry.row), [editorView]);
    const historyList = useMemo(() => historyView.map((entry) => entry.row), [historyView]);
    const triggerList = useMemo(() => triggerView.map((entry) => entry.row), [triggerView]);
    const approvalList = useMemo(() => approvalView.map((entry) => entry.row), [approvalView]);

    const selectedRunVisibleIndex = useMemo(() => runViewIndices.indexOf(ui.selectedRunIndex), [runViewIndices, ui.selectedRunIndex]);
    const selectedPipelineVisibleIndex = useMemo(() => pipelineViewIndices.indexOf(ui.selectedPipelineIndex), [pipelineViewIndices, ui.selectedPipelineIndex]);
    const selectedEditorVisibleIndex = useMemo(() => editorViewIndices.indexOf(ui.selectedEditorNodeIndex), [editorViewIndices, ui.selectedEditorNodeIndex]);
    const selectedHistoryVisibleIndex = useMemo(() => historyViewIndices.indexOf(ui.selectedHistoryIndex), [historyViewIndices, ui.selectedHistoryIndex]);
    const selectedTriggerVisibleIndex = useMemo(() => triggerViewIndices.indexOf(ui.selectedTriggerIndex), [triggerViewIndices, ui.selectedTriggerIndex]);
    const selectedApprovalVisibleIndex = useMemo(() => approvalViewIndices.indexOf(ui.selectedApprovalIndex), [approvalViewIndices, ui.selectedApprovalIndex]);

    const eventWindowSize = layoutMode === 'wide' ? 22 : layoutMode === 'compact' ? 16 : 10;
    const logWindowSize = layoutMode === 'wide' ? 12 : layoutMode === 'compact' ? 10 : 8;
    const visibleEvents = useMemo(() => tailWindow(eventLines, eventWindowSize, ui.eventOffset), [eventLines, eventWindowSize, ui.eventOffset]);
    const visibleLogs = useMemo(() => tailWindow(logLines, logWindowSize, ui.logOffset), [logLines, logWindowSize, ui.logOffset]);
    const tabCounts = useMemo(() => {
        return {
            run: { visible: runList.length, total: runs.length, filtered: Boolean(filters.run.trim()) },
            pipelines: { visible: pipelineList.length, total: pipelines.length, filtered: Boolean(filters.pipelines.trim()) },
            editor: { visible: editorList.length, total: editorNodes.length, filtered: Boolean(filters.editor.trim()) },
            history: { visible: historyList.length, total: historyRows.length, filtered: Boolean(filters.history.trim()) },
            diff: { visible: diffViewLines.length, total: diffLines.length, filtered: Boolean(filters.diff.trim()) },
            triggers: { visible: triggerList.length, total: triggerRows.length, filtered: Boolean(filters.triggers.trim()) },
            hitl: { visible: approvalList.length, total: approvals.length, filtered: Boolean(filters.hitl.trim()) }
        };
    }, [
        approvalList.length,
        approvals.length,
        diffLines.length,
        diffViewLines.length,
        editorList.length,
        editorNodes.length,
        filters.diff,
        filters.editor,
        filters.history,
        filters.hitl,
        filters.pipelines,
        filters.run,
        filters.triggers,
        historyList.length,
        historyRows.length,
        pipelineList.length,
        pipelines.length,
        runList.length,
        runs.length,
        triggerList.length,
        triggerRows.length
    ]);

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

    const refreshCurrentTab = useCallback(() => {
        if (ui.activeTab === 'run') {
            refreshRuns();
            tailSelectedRun();
            setStatus('Refresh tab Run exécuté.', 'ok');
            return;
        }
        if (ui.activeTab === 'pipelines') {
            refreshPipelines();
            setStatus('Refresh tab Pipelines exécuté.', 'ok');
            return;
        }
        if (ui.activeTab === 'editor') {
            refreshEditorNodes();
            setStatus('Refresh tab Editor exécuté.', 'ok');
            return;
        }
        if (ui.activeTab === 'history') {
            void refreshHistory();
            setStatus('Refresh tab History exécuté.', 'ok');
            return;
        }
        if (ui.activeTab === 'diff') {
            void refreshDiff();
            setStatus('Refresh tab Diff exécuté.', 'ok');
            return;
        }
        if (ui.activeTab === 'triggers') {
            refreshTriggers();
            setStatus('Refresh tab Triggers exécuté.', 'ok');
            return;
        }
        refreshApprovals();
        setStatus('Refresh tab HITL exécuté.', 'ok');
    }, [
        refreshApprovals,
        refreshDiff,
        refreshEditorNodes,
        refreshHistory,
        refreshPipelines,
        refreshRuns,
        refreshTriggers,
        setStatus,
        tailSelectedRun,
        ui.activeTab
    ]);

    const jumpToBoundary = useCallback((target: 'first' | 'last') => {
        const goLast = target === 'last';
        if (ui.activeTab === 'run') {
            if (ui.focusZone === 'left') {
                const next = boundaryWithinView(runViewIndices, goLast ? 'last' : 'first');
                if (next !== undefined) {
                    dispatch({ type: 'select_index', key: 'run', index: next, max: runs.length });
                }
                return;
            }
            if (ui.focusZone === 'center') {
                const delta = goLast ? -999999 : eventLines.length + ui.eventOffset + 999999;
                dispatch({ type: 'scroll_events', delta });
                return;
            }
            if (ui.focusZone === 'right') {
                const delta = goLast ? -999999 : logLines.length + ui.logOffset + 999999;
                dispatch({ type: 'scroll_logs', delta });
            }
            return;
        }
        if (ui.activeTab === 'pipelines') {
            const next = boundaryWithinView(pipelineViewIndices, goLast ? 'last' : 'first');
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'pipeline', index: next, max: pipelines.length });
            }
            return;
        }
        if (ui.activeTab === 'editor') {
            const next = boundaryWithinView(editorViewIndices, goLast ? 'last' : 'first');
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'editor', index: next, max: editorNodes.length });
            }
            return;
        }
        if (ui.activeTab === 'history') {
            const next = boundaryWithinView(historyViewIndices, goLast ? 'last' : 'first');
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'history', index: next, max: historyRows.length });
            }
            return;
        }
        if (ui.activeTab === 'triggers') {
            const next = boundaryWithinView(triggerViewIndices, goLast ? 'last' : 'first');
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'trigger', index: next, max: triggerRows.length });
            }
            return;
        }
        if (ui.activeTab === 'hitl') {
            const next = boundaryWithinView(approvalViewIndices, goLast ? 'last' : 'first');
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'approval', index: next, max: approvals.length });
            }
        }
    }, [
        approvalViewIndices,
        approvals.length,
        editorNodes.length,
        editorViewIndices,
        eventLines.length,
        historyViewIndices,
        historyRows.length,
        logLines.length,
        pipelineViewIndices,
        pipelines.length,
        runViewIndices,
        runs.length,
        triggerViewIndices,
        triggerRows.length,
        ui.activeTab,
        ui.eventOffset,
        ui.focusZone,
        ui.logOffset
    ]);

    const openCurrentTabFilter = useCallback(() => {
        const key = filterKeyForTab(ui.activeTab);
        const currentValue = filters[key];
        openPrompt(
            `Filtre tab ${ui.activeTab}`,
            currentValue,
            (value) => {
                setFilters((previous) => ({
                    ...previous,
                    [key]: String(value || '').trim()
                }));
                setStatus(String(value || '').trim() ? `Filtre ${ui.activeTab} appliqué.` : `Filtre ${ui.activeTab} vidé.`, 'ok');
            },
            'Filtre local de la tab active (insensible à la casse).'
        );
    }, [filters, openPrompt, setStatus, ui.activeTab]);

    const clearCurrentTabFilter = useCallback(() => {
        const key = filterKeyForTab(ui.activeTab);
        setFilters((previous) => {
            if (!previous[key]) return previous;
            return {
                ...previous,
                [key]: ''
            };
        });
        setStatus(`Filtre ${ui.activeTab} vidé.`, 'info');
    }, [setStatus, ui.activeTab]);

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
        if (item.id === 'action:refresh-current') {
            refreshCurrentTab();
            return;
        }
        if (item.id === 'action:jump-first') {
            jumpToBoundary('first');
            setStatus('Jump vers le premier élément.', 'info');
            return;
        }
        if (item.id === 'action:jump-last') {
            jumpToBoundary('last');
            setStatus('Jump vers le dernier élément.', 'info');
            return;
        }
        if (item.id === 'action:toggle-help') {
            dispatch({ type: 'toggle_help' });
            return;
        }
        if (item.id === 'action:filter-current') {
            openCurrentTabFilter();
            return;
        }
        if (item.id === 'action:filter-clear') {
            clearCurrentTabFilter();
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
        if (item.id === 'action:run-pause' && selectedRunId) {
            try {
                supervisor.pause_run(selectedRunId);
                setStatus(`Pause demandée pour ${selectedRunId}`, 'warn');
            } catch (error: any) {
                setStatus(`Pause échouée: ${String(error?.message || error)}`, 'err');
            }
            return;
        }
        if (item.id === 'action:run-resume' && selectedRunId) {
            try {
                supervisor.resume_run(selectedRunId);
                setStatus(`Resume demandée pour ${selectedRunId}`, 'ok');
            } catch (error: any) {
                setStatus(`Resume échouée: ${String(error?.message || error)}`, 'err');
            }
            return;
        }
        if (item.id === 'action:run-cancel' && selectedRunId) {
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
            return;
        }
        if (item.id === 'action:pipeline-run' && selectedPipeline) {
            startDetachedPipeline(selectedPipeline);
            return;
        }
        if (item.id === 'action:pipeline-dry' && selectedPipeline) {
            void runtime.run_pipeline_file(String(selectedPipeline.path || ''), { dryRun: true })
                .then((result: any) => {
                    setStatus(`Dry-run ${result?.success ? 'ok' : 'failed'} (${String(result?.runId || '-')})`, result?.success ? 'ok' : 'warn');
                })
                .catch((error: any) => {
                    setStatus(`Dry-run échoué: ${String(error?.message || error)}`, 'err');
                });
            return;
        }
        if (item.id === 'action:pipeline-open-editor') {
            dispatch({ type: 'switch_tab', tab: 'editor' });
            dispatch({ type: 'set_focus', zone: defaultFocusForTab('editor') });
            return;
        }
        if (item.id === 'action:diff-refresh') {
            void refreshDiff();
            setStatus('Diff refresh demandée.', 'ok');
            return;
        }
        if (item.id === 'action:trigger-start') {
            void triggerService.start()
                .then(() => setStatus('Triggers démarrés.', 'ok'))
                .catch((error: any) => setStatus(`Start triggers échoué: ${String(error?.message || error)}`, 'err'));
            return;
        }
        if (item.id === 'action:trigger-stop') {
            void triggerService.stop()
                .then(() => setStatus('Triggers stoppés.', 'warn'))
                .catch((error: any) => setStatus(`Stop triggers échoué: ${String(error?.message || error)}`, 'err'));
            return;
        }
        if (item.id === 'action:trigger-refresh') {
            void triggerService.refresh()
                .then(() => {
                    refreshTriggers();
                    setStatus('Triggers refresh exécuté.', 'ok');
                })
                .catch((error: any) => setStatus(`Refresh triggers échoué: ${String(error?.message || error)}`, 'err'));
            return;
        }
        if (item.id === 'action:approval-approve' && selectedApproval) {
            try {
                approvalService.resolve({ pendingId: selectedApproval.id, decision: 'approve' });
                refreshApprovals();
                setStatus(`Approval accepté: ${String(selectedApproval.id)}`, 'ok');
            } catch (error: any) {
                setStatus(`Approve échoué: ${String(error?.message || error)}`, 'err');
            }
            return;
        }
        if (item.id === 'action:approval-reject' && selectedApproval) {
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
            return;
        }

        dispatch(item.event);
        if (item.followUpEvent) {
            dispatch(item.followUpEvent);
        }
    }, [
        approvalService,
        jumpToBoundary,
        openConfirm,
        openCurrentTabFilter,
        refreshApprovals,
        clearCurrentTabFilter,
        refreshCurrentTab,
        refreshDiff,
        refreshEditorNodes,
        refreshHistory,
        refreshPipelines,
        refreshRuns,
        refreshTriggers,
        runtime,
        selectedApproval,
        selectedPipeline,
        selectedRunId,
        setStatus,
        startDetachedPipeline,
        supervisor,
        triggerService
    ]);

    const moveByFocus = useCallback((delta: number) => {
        if (ui.activeTab === 'run') {
            if (ui.focusZone === 'left') {
                const next = moveWithinView(runViewIndices, ui.selectedRunIndex, delta);
                if (next !== undefined) {
                    dispatch({ type: 'select_index', key: 'run', index: next, max: runs.length });
                }
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
            const next = moveWithinView(pipelineViewIndices, ui.selectedPipelineIndex, delta);
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'pipeline', index: next, max: pipelines.length });
            }
            return;
        }

        if (ui.activeTab === 'editor') {
            const next = moveWithinView(editorViewIndices, ui.selectedEditorNodeIndex, delta);
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'editor', index: next, max: editorNodes.length });
            }
            return;
        }

        if (ui.activeTab === 'history') {
            const next = moveWithinView(historyViewIndices, ui.selectedHistoryIndex, delta);
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'history', index: next, max: historyRows.length });
            }
            return;
        }

        if (ui.activeTab === 'triggers') {
            const next = moveWithinView(triggerViewIndices, ui.selectedTriggerIndex, delta);
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'trigger', index: next, max: triggerRows.length });
            }
            return;
        }

        if (ui.activeTab === 'hitl') {
            const next = moveWithinView(approvalViewIndices, ui.selectedApprovalIndex, delta);
            if (next !== undefined) {
                dispatch({ type: 'select_index', key: 'approval', index: next, max: approvals.length });
            }
        }
    }, [
        approvalViewIndices,
        approvals.length,
        editorNodes.length,
        editorViewIndices,
        historyRows.length,
        historyViewIndices,
        pipelineViewIndices,
        pipelines.length,
        runViewIndices,
        runs.length,
        triggerRows.length,
        triggerViewIndices,
        ui.activeTab,
        ui.focusZone,
        ui.selectedApprovalIndex,
        ui.selectedEditorNodeIndex,
        ui.selectedHistoryIndex,
        ui.selectedPipelineIndex,
        ui.selectedRunIndex,
        ui.selectedTriggerIndex
    ]);

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
        if (runViewIndices.length === 0) return;
        if (!runViewIndices.includes(ui.selectedRunIndex)) {
            dispatch({ type: 'select_index', key: 'run', index: runViewIndices[0], max: runs.length });
        }
    }, [runViewIndices, runs.length, ui.selectedRunIndex]);

    useEffect(() => {
        if (pipelineViewIndices.length === 0) return;
        if (!pipelineViewIndices.includes(ui.selectedPipelineIndex)) {
            dispatch({ type: 'select_index', key: 'pipeline', index: pipelineViewIndices[0], max: pipelines.length });
        }
    }, [pipelineViewIndices, pipelines.length, ui.selectedPipelineIndex]);

    useEffect(() => {
        if (editorViewIndices.length === 0) return;
        if (!editorViewIndices.includes(ui.selectedEditorNodeIndex)) {
            dispatch({ type: 'select_index', key: 'editor', index: editorViewIndices[0], max: editorNodes.length });
        }
    }, [editorNodes.length, editorViewIndices, ui.selectedEditorNodeIndex]);

    useEffect(() => {
        if (historyViewIndices.length === 0) return;
        if (!historyViewIndices.includes(ui.selectedHistoryIndex)) {
            dispatch({ type: 'select_index', key: 'history', index: historyViewIndices[0], max: historyRows.length });
        }
    }, [historyRows.length, historyViewIndices, ui.selectedHistoryIndex]);

    useEffect(() => {
        if (triggerViewIndices.length === 0) return;
        if (!triggerViewIndices.includes(ui.selectedTriggerIndex)) {
            dispatch({ type: 'select_index', key: 'trigger', index: triggerViewIndices[0], max: triggerRows.length });
        }
    }, [triggerRows.length, triggerViewIndices, ui.selectedTriggerIndex]);

    useEffect(() => {
        if (approvalViewIndices.length === 0) return;
        if (!approvalViewIndices.includes(ui.selectedApprovalIndex)) {
            dispatch({ type: 'select_index', key: 'approval', index: approvalViewIndices[0], max: approvals.length });
        }
    }, [approvalViewIndices, approvals.length, ui.selectedApprovalIndex]);

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
            },
            {
                id: 'action:refresh-current',
                label: 'Refresh tab active',
                hint: 'action',
                category: 'action',
                keywords: ['refresh', 'tab', 'current'],
                event: { type: 'set_status', text: 'Refresh tab active', tone: 'info' }
            },
            {
                id: 'action:jump-first',
                label: 'Jump premier élément',
                hint: 'action',
                category: 'action',
                keywords: ['jump', 'top', 'first', 'g'],
                event: { type: 'set_status', text: 'Jump top', tone: 'info' }
            },
            {
                id: 'action:jump-last',
                label: 'Jump dernier élément',
                hint: 'action',
                category: 'action',
                keywords: ['jump', 'bottom', 'last', 'G'],
                event: { type: 'set_status', text: 'Jump bottom', tone: 'info' }
            },
            {
                id: 'action:toggle-help',
                label: 'Toggle aide contextuelle',
                hint: 'action',
                category: 'action',
                keywords: ['help', 'shortcut', 'keyboard'],
                event: { type: 'toggle_help' }
            },
            {
                id: 'action:filter-current',
                label: `Filtrer tab ${ui.activeTab}`,
                hint: 'action',
                category: 'action',
                keywords: ['filter', 'search', 'tab', ui.activeTab],
                event: { type: 'set_status', text: 'Ouvrir filtre tab', tone: 'info' }
            },
            {
                id: 'action:filter-clear',
                label: `Vider filtre tab ${ui.activeTab}`,
                hint: 'action',
                category: 'action',
                keywords: ['filter', 'clear', 'reset', ui.activeTab],
                event: { type: 'set_status', text: 'Vider filtre tab', tone: 'info' }
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

        if (selectedRunId) {
            items.push(
                {
                    id: 'action:run-pause',
                    label: `Pause run ${selectedRunId}`,
                    hint: 'run',
                    category: 'action',
                    keywords: ['run', 'pause', selectedRunId],
                    event: { type: 'set_status', text: 'Pause run', tone: 'warn' }
                },
                {
                    id: 'action:run-resume',
                    label: `Resume run ${selectedRunId}`,
                    hint: 'run',
                    category: 'action',
                    keywords: ['run', 'resume', selectedRunId],
                    event: { type: 'set_status', text: 'Resume run', tone: 'ok' }
                },
                {
                    id: 'action:run-cancel',
                    label: `Cancel run ${selectedRunId}`,
                    hint: 'run',
                    category: 'action',
                    keywords: ['run', 'cancel', selectedRunId],
                    event: { type: 'set_status', text: 'Cancel run', tone: 'warn' }
                }
            );
        }

        if (selectedPipeline) {
            const pipelineLabel = String(selectedPipeline?.name || selectedPipeline?.path || 'selected_pipeline');
            items.push(
                {
                    id: 'action:pipeline-run',
                    label: `Run pipeline ${pipelineLabel}`,
                    hint: 'pipeline',
                    category: 'action',
                    keywords: ['pipeline', 'run', pipelineLabel],
                    event: { type: 'set_status', text: 'Run pipeline', tone: 'ok' }
                },
                {
                    id: 'action:pipeline-dry',
                    label: `Dry-run pipeline ${pipelineLabel}`,
                    hint: 'pipeline',
                    category: 'action',
                    keywords: ['pipeline', 'dry-run', 'dry', pipelineLabel],
                    event: { type: 'set_status', text: 'Dry-run pipeline', tone: 'info' }
                },
                {
                    id: 'action:pipeline-open-editor',
                    label: 'Ouvrir Editor du pipeline',
                    hint: 'pipeline',
                    category: 'action',
                    keywords: ['pipeline', 'editor', 'open'],
                    event: { type: 'switch_tab', tab: 'editor' }
                }
            );
        }

        if (ui.activeTab === 'diff') {
            items.push({
                id: 'action:diff-refresh',
                label: 'Refresh diff',
                hint: 'diff',
                category: 'action',
                keywords: ['diff', 'refresh'],
                event: { type: 'set_status', text: 'Refresh diff', tone: 'info' }
            });
        }

        if (ui.activeTab === 'triggers' || triggerRows.length > 0) {
            items.push(
                {
                    id: 'action:trigger-start',
                    label: 'Start triggers',
                    hint: 'trigger',
                    category: 'action',
                    keywords: ['trigger', 'start', 'daemon'],
                    event: { type: 'set_status', text: 'Start triggers', tone: 'ok' }
                },
                {
                    id: 'action:trigger-stop',
                    label: 'Stop triggers',
                    hint: 'trigger',
                    category: 'action',
                    keywords: ['trigger', 'stop'],
                    event: { type: 'set_status', text: 'Stop triggers', tone: 'warn' }
                },
                {
                    id: 'action:trigger-refresh',
                    label: 'Refresh triggers',
                    hint: 'trigger',
                    category: 'action',
                    keywords: ['trigger', 'refresh'],
                    event: { type: 'set_status', text: 'Refresh triggers', tone: 'info' }
                }
            );
        }

        if (selectedApproval) {
            items.push(
                {
                    id: 'action:approval-approve',
                    label: `Approve ${String(selectedApproval.id)}`,
                    hint: 'hitl',
                    category: 'action',
                    keywords: ['approval', 'approve', String(selectedApproval.id)],
                    event: { type: 'set_status', text: 'Approve', tone: 'ok' }
                },
                {
                    id: 'action:approval-reject',
                    label: `Reject ${String(selectedApproval.id)}`,
                    hint: 'hitl',
                    category: 'action',
                    keywords: ['approval', 'reject', String(selectedApproval.id)],
                    event: { type: 'set_status', text: 'Reject', tone: 'warn' }
                }
            );
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
    }, [
        approvals,
        editorNodes,
        historyRows,
        pipelines,
        runs,
        selectedApproval,
        selectedPipeline,
        selectedRunId,
        triggerRows,
        ui.activeTab
    ]);

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
        if (action.type === 'switch_tab_relative') {
            const nextTab = shiftTab(ui.activeTab, action.delta);
            dispatch({ type: 'switch_tab', tab: nextTab });
            dispatch({ type: 'set_focus', zone: defaultFocusForTab(nextTab) });
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

        if (input === '/') {
            if (props.config.palette.enabled) {
                dispatch({ type: 'open_palette' });
            } else {
                setStatus('Palette désactivée via config.', 'warn');
            }
            return;
        }
        if (input === 'R') {
            refreshCurrentTab();
            return;
        }
        if (input === 'g') {
            jumpToBoundary('first');
            return;
        }
        if (input === 'G') {
            jumpToBoundary('last');
            return;
        }
        if (input === 'F') {
            openCurrentTabFilter();
            return;
        }
        if (input === 'C') {
            clearCurrentTabFilter();
            return;
        }

        applyTabAction(input, key);
    });

    const tabActionHint = useMemo(() => {
        if (ui.activeTab === 'run') return 'Run: p pause | r resume | c cancel | [ ] events | { } logs | F/C filtre';
        if (ui.activeTab === 'pipelines') return 'Pipelines: Enter/r run | d dry-run | n new | x delete | e editor | F/C filtre';
        if (ui.activeTab === 'editor') return 'Editor: a add | y yaml | v pipeline yaml | i/m/o/c fields | u/j reorder | F/C filtre';
        if (ui.activeTab === 'history') return 'History: navigation + jump vers Diff via palette | F/C filtre';
        if (ui.activeTab === 'diff') return 'Diff: f refresh | F/C filtre';
        if (ui.activeTab === 'triggers') return 'Triggers: s start | x stop | f refresh | F/C filtre';
        return 'HITL: a approve | r reject | F/C filtre';
    }, [ui.activeTab]);

    const compactStatusLine = useMemo(() => {
        const max = Math.max(40, Math.min(stdoutColumns - 4, 120));
        const text = [
            `Tab:${ui.activeTab.toUpperCase()}`,
            `Run:${selectedRunId || '-'}`,
            `Pipe:${String(selectedPipeline?.name || '-')}`,
            `Hist:${String(selectedHistory?.id || '-')}`,
            `Trig:${String(selectedTrigger?.id || '-')}`,
            `HITL:${String(selectedApproval?.id || '-')}`,
            `Layout:${layoutMode}/${stdoutColumns}c`,
            `Status:${toUpperSafe(selectedRun?.status || 'idle')}`
        ].join(' | ');
        return compactText(text, max);
    }, [
        layoutMode,
        selectedApproval?.id,
        selectedHistory?.id,
        selectedPipeline?.name,
        selectedRun?.status,
        selectedRunId,
        selectedTrigger?.id,
        stdoutColumns,
        ui.activeTab
    ]);

    const shellHelp = useMemo(() => {
        const prompt = ui.prompt.open ? 'PROMPT' : ui.confirm.open ? 'CONFIRM' : ui.palette.open ? 'PALETTE' : 'NORMAL';
        const raw = `Mode ${prompt} | 1..7 tabs | Shift+←/→ tabs | Tab focus | Ctrl+K or / palette | editor:${resolveEditorCommand()}`;
        return compactText(raw, Math.max(40, Math.min(stdoutColumns - 4, 110)));
    }, [stdoutColumns, ui.confirm.open, ui.palette.open, ui.prompt.open]);

    const topKeybinds = useMemo(() => {
        return [
            { key: '1..7', label: 'Tabs' },
            { key: 'Shift+←/→', label: 'Tab +/-' },
            { key: 'Tab', label: 'Focus' },
            { key: 'Ctrl+K /', label: 'Palette' },
            { key: 'F/C', label: 'Filtre' },
            { key: 'R', label: 'Refresh' },
            { key: 'g/G', label: 'Jump' },
            { key: '?', label: 'Aide' }
        ];
    }, []);

    const footerKeybinds = useMemo(() => {
        return [
            { key: 'p/r/c', label: 'Run control' },
            { key: 's/x/f', label: 'Triggers' },
            { key: 'a/r', label: 'HITL' }
        ];
    }, []);

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header
                theme={theme}
                workspaceRoot={props.workspaceRoot}
                selectedRunId={selectedRunId}
                selectedRunStatus={String(selectedRun?.status || 'idle')}
                uiVersion={`v2 (${props.config.keymap.profile})`}
            />

            <TabBar activeTab={ui.activeTab} theme={theme} counts={tabCounts} />
            <KeybindStrip
                theme={theme}
                title="Raccourcis essentiels"
                items={topKeybinds}
            />

            {ui.activeTab === 'run' && (
                <RunScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    runs={runList}
                    selectedRunIndex={selectedRunVisibleIndex}
                    visibleEvents={visibleEvents}
                    visibleLogs={visibleLogs}
                    eventTotal={eventLines.length}
                    eventMax={props.config.maxEvents}
                    logTotal={logLines.length}
                    logMax={props.config.maxLogs}
                    eventOffset={ui.eventOffset}
                    logOffset={ui.logOffset}
                    filterQuery={filters.run}
                />
            )}

            {ui.activeTab === 'pipelines' && (
                <PipelinesScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    pipelines={pipelineList}
                    selectedPipelineIndex={selectedPipelineVisibleIndex}
                    filterQuery={filters.pipelines}
                />
            )}

            {ui.activeTab === 'editor' && (
                <EditorScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    pipelinePath={String(selectedPipeline?.path || '')}
                    nodes={editorList}
                    selectedNodeIndex={selectedEditorVisibleIndex}
                    yamlPreview={yamlPreview}
                    filterQuery={filters.editor}
                />
            )}

            {ui.activeTab === 'history' && (
                <HistoryScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    historyRows={historyList}
                    selectedHistoryIndex={selectedHistoryVisibleIndex}
                    filterQuery={filters.history}
                />
            )}

            {ui.activeTab === 'diff' && (
                <DiffScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    source={diffSource}
                    lines={diffViewLines}
                    filterQuery={filters.diff}
                />
            )}

            {ui.activeTab === 'triggers' && (
                <TriggersScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    triggerRows={triggerList}
                    selectedTriggerIndex={selectedTriggerVisibleIndex}
                    filterQuery={filters.triggers}
                />
            )}

            {ui.activeTab === 'hitl' && (
                <HitlScreen
                    theme={theme}
                    layoutMode={layoutMode}
                    focusZone={ui.focusZone}
                    approvals={approvalList}
                    selectedApprovalIndex={selectedApprovalVisibleIndex}
                    filterQuery={filters.hitl}
                />
            )}

            <Footer
                theme={theme}
                statusText={`${theme.symbols.bullet} ${ui.status.text}`}
                tone={ui.status.tone}
                helpHint={`${shellHelp} | ${tabActionHint}`}
                keybinds={footerKeybinds}
            />

            <Box marginTop={1}>
                <Text color={theme.colors.muted}>
                    {compactStatusLine} {theme.symbols.separator} Heure:{formatTime(Date.now())}
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
                <Text color={theme.colors.muted}>Config: intentRouter.tui.ui.version | theme.highContrast | keymap.profile | palette.enabled | palette.trigger | filtres tab via F/C</Text>
            </Box>
        </Box>
    );
}
