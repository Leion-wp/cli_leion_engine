import { FocusZone, SelectionKey, StatusTone, TabId, UiState, UiStateMachineEvent } from './types';

const TAB_ORDER: TabId[] = ['run', 'pipelines', 'editor', 'history', 'diff', 'triggers', 'hitl'];

function bounded(index: number, max: number): number {
    if (max <= 0) return 0;
    if (index < 0) return 0;
    if (index >= max) return max - 1;
    return index;
}

function setIndex(state: UiState, key: SelectionKey, nextValue: number, max: number): UiState {
    const value = bounded(nextValue, max);
    if (key === 'run') {
        if (state.selectedRunIndex === value) return state;
        return { ...state, selectedRunIndex: value };
    }
    if (key === 'pipeline') {
        if (state.selectedPipelineIndex === value) return state;
        return { ...state, selectedPipelineIndex: value };
    }
    if (key === 'editor') {
        if (state.selectedEditorNodeIndex === value) return state;
        return { ...state, selectedEditorNodeIndex: value };
    }
    if (key === 'history') {
        if (state.selectedHistoryIndex === value) return state;
        return { ...state, selectedHistoryIndex: value };
    }
    if (key === 'trigger') {
        if (state.selectedTriggerIndex === value) return state;
        return { ...state, selectedTriggerIndex: value };
    }
    if (state.selectedApprovalIndex === value) return state;
    return { ...state, selectedApprovalIndex: value };
}

function focusOrderForTab(tab: TabId): FocusZone[] {
    if (tab === 'run') return ['tabs', 'left', 'center', 'right', 'footer'];
    if (tab === 'diff') return ['tabs', 'center', 'right', 'footer'];
    return ['tabs', 'left', 'right', 'footer'];
}

function cycleFocus(state: UiState, reverse = false): UiState {
    const order = focusOrderForTab(state.activeTab);
    const currentIndex = order.indexOf(state.focusZone);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = reverse
        ? (safeIndex - 1 + order.length) % order.length
        : (safeIndex + 1) % order.length;
    if (order[nextIndex] === state.focusZone) return state;
    return { ...state, focusZone: order[nextIndex] };
}

function status(text: string, tone: StatusTone = 'info'): UiState['status'] {
    return { text, tone };
}

export function createInitialUiState(): UiState {
    return {
        activeTab: 'run',
        focusZone: 'left',
        showHelp: false,
        status: status('Ready', 'info'),
        prompt: {
            open: false,
            title: '',
            value: ''
        },
        confirm: {
            open: false,
            title: '',
            body: '',
            actionKey: ''
        },
        palette: {
            open: false,
            query: '',
            selectedIndex: 0
        },
        selectedRunIndex: 0,
        selectedPipelineIndex: 0,
        selectedEditorNodeIndex: 0,
        selectedHistoryIndex: 0,
        selectedTriggerIndex: 0,
        selectedApprovalIndex: 0,
        eventOffset: 0,
        logOffset: 0
    };
}

export function uiReducer(state: UiState, event: UiStateMachineEvent): UiState {
    if (event.type === 'switch_tab') {
        const nextFocus = focusOrderForTab(event.tab)[1] || 'left';
        if (state.activeTab === event.tab && state.focusZone === nextFocus && state.showHelp === false) {
            return state;
        }
        return {
            ...state,
            activeTab: event.tab,
            focusZone: nextFocus,
            showHelp: false
        };
    }
    if (event.type === 'toggle_help') {
        return { ...state, showHelp: !state.showHelp };
    }
    if (event.type === 'set_status') {
        const nextStatus = status(event.text, event.tone || 'info');
        if (state.status.text === nextStatus.text && state.status.tone === nextStatus.tone) {
            return state;
        }
        return { ...state, status: nextStatus };
    }
    if (event.type === 'set_focus') {
        if (state.focusZone === event.zone) return state;
        return { ...state, focusZone: event.zone };
    }
    if (event.type === 'cycle_focus') {
        return cycleFocus(state, event.reverse === true);
    }
    if (event.type === 'open_palette') {
        if (state.palette.open && state.focusZone === 'palette' && state.palette.query === '' && state.palette.selectedIndex === 0) {
            return state;
        }
        return {
            ...state,
            palette: {
                open: true,
                query: '',
                selectedIndex: 0
            },
            focusZone: 'palette'
        };
    }
    if (event.type === 'close_palette') {
        const nextFocus = focusOrderForTab(state.activeTab)[1] || 'left';
        if (!state.palette.open && state.palette.query === '' && state.palette.selectedIndex === 0 && state.focusZone === nextFocus) {
            return state;
        }
        return {
            ...state,
            palette: {
                ...state.palette,
                open: false,
                query: '',
                selectedIndex: 0
            },
            focusZone: nextFocus
        };
    }
    if (event.type === 'palette_query') {
        if (state.palette.query === event.query && state.palette.selectedIndex === 0) return state;
        return {
            ...state,
            palette: {
                ...state.palette,
                query: event.query,
                selectedIndex: 0
            }
        };
    }
    if (event.type === 'palette_move') {
        const max = Math.max(0, event.max);
        const current = state.palette.selectedIndex;
        const next = bounded(current + event.delta, max);
        if (next === current) return state;
        return {
            ...state,
            palette: {
                ...state.palette,
                selectedIndex: next
            }
        };
    }
    if (event.type === 'open_prompt') {
        if (
            state.prompt.open
            && state.prompt.title === event.title
            && state.prompt.value === event.value
            && state.prompt.description === event.description
            && state.focusZone === 'prompt'
        ) {
            return state;
        }
        return {
            ...state,
            prompt: {
                open: true,
                title: event.title,
                value: event.value,
                description: event.description
            },
            focusZone: 'prompt'
        };
    }
    if (event.type === 'close_prompt') {
        const nextFocus = focusOrderForTab(state.activeTab)[1] || 'left';
        if (!state.prompt.open && state.prompt.title === '' && state.prompt.value === '' && state.focusZone === nextFocus) {
            return state;
        }
        return {
            ...state,
            prompt: {
                open: false,
                title: '',
                value: ''
            },
            focusZone: nextFocus
        };
    }
    if (event.type === 'prompt_set') {
        if (state.prompt.value === event.value) return state;
        return {
            ...state,
            prompt: {
                ...state.prompt,
                value: event.value
            }
        };
    }
    if (event.type === 'open_confirm') {
        if (
            state.confirm.open
            && state.confirm.title === event.title
            && state.confirm.body === event.body
            && state.confirm.actionKey === event.actionKey
            && state.focusZone === 'prompt'
        ) {
            return state;
        }
        return {
            ...state,
            confirm: {
                open: true,
                title: event.title,
                body: event.body,
                actionKey: event.actionKey
            },
            focusZone: 'prompt'
        };
    }
    if (event.type === 'close_confirm') {
        const nextFocus = focusOrderForTab(state.activeTab)[1] || 'left';
        if (!state.confirm.open && state.confirm.title === '' && state.confirm.body === '' && state.confirm.actionKey === '' && state.focusZone === nextFocus) {
            return state;
        }
        return {
            ...state,
            confirm: {
                open: false,
                title: '',
                body: '',
                actionKey: ''
            },
            focusZone: nextFocus
        };
    }
    if (event.type === 'select_index') {
        return setIndex(state, event.key, event.index, event.max);
    }
    if (event.type === 'move_index') {
        const current = event.key === 'run'
            ? state.selectedRunIndex
            : event.key === 'pipeline'
                ? state.selectedPipelineIndex
                : event.key === 'editor'
                    ? state.selectedEditorNodeIndex
                    : event.key === 'history'
                        ? state.selectedHistoryIndex
                        : event.key === 'trigger'
                            ? state.selectedTriggerIndex
                            : state.selectedApprovalIndex;
        return setIndex(state, event.key, current + event.delta, event.max);
    }
    if (event.type === 'scroll_events') {
        const next = Math.max(0, state.eventOffset + event.delta);
        if (next === state.eventOffset) return state;
        return { ...state, eventOffset: next };
    }
    if (event.type === 'scroll_logs') {
        const next = Math.max(0, state.logOffset + event.delta);
        if (next === state.logOffset) return state;
        return { ...state, logOffset: next };
    }
    return state;
}

export const TAB_SHORTCUTS: Record<string, TabId> = {
    '1': 'run',
    '2': 'pipelines',
    '3': 'editor',
    '4': 'history',
    '5': 'diff',
    '6': 'triggers',
    '7': 'hitl'
};

export const TAB_TITLES: Record<TabId, string> = {
    run: 'Run',
    pipelines: 'Pipelines',
    editor: 'Editor',
    history: 'History',
    diff: 'Diff',
    triggers: 'Triggers',
    hitl: 'HITL'
};

export function shiftTab(current: TabId, delta: -1 | 1): TabId {
    const index = TAB_ORDER.indexOf(current);
    const safeIndex = index >= 0 ? index : 0;
    const next = (safeIndex + delta + TAB_ORDER.length) % TAB_ORDER.length;
    return TAB_ORDER[next];
}
