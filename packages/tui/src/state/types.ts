export type TabId = 'run' | 'pipelines' | 'editor' | 'history' | 'diff' | 'triggers' | 'hitl';

export type FocusZone = 'tabs' | 'left' | 'center' | 'right' | 'footer' | 'palette' | 'prompt';

export type TuiThemeName = 'leion-pro';

export type TuiKeymapProfile = 'hybrid' | 'classic';

export type UiVersion = 'v2' | 'legacy';

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

export interface StatusMessage {
    text: string;
    tone: StatusTone;
}

export interface TuiUiConfig {
    version: UiVersion;
}

export interface TuiThemeConfig {
    name: TuiThemeName;
    highContrast: boolean;
}

export interface TuiKeymapConfig {
    profile: TuiKeymapProfile;
}

export interface TuiPaletteConfig {
    enabled: boolean;
    trigger: 'ctrl+k';
}

export interface TuiRuntimeConfig {
    maxLogs: number;
    maxEvents: number;
    ui: TuiUiConfig;
    theme: TuiThemeConfig;
    keymap: TuiKeymapConfig;
    palette: TuiPaletteConfig;
}

export interface PromptState {
    open: boolean;
    title: string;
    value: string;
    description?: string;
}

export interface ConfirmState {
    open: boolean;
    title: string;
    body: string;
    actionKey: string;
}

export interface PaletteState {
    open: boolean;
    query: string;
    selectedIndex: number;
}

export interface UiState {
    activeTab: TabId;
    focusZone: FocusZone;
    showHelp: boolean;
    status: StatusMessage;
    prompt: PromptState;
    confirm: ConfirmState;
    palette: PaletteState;
    selectedRunIndex: number;
    selectedPipelineIndex: number;
    selectedEditorNodeIndex: number;
    selectedHistoryIndex: number;
    selectedTriggerIndex: number;
    selectedApprovalIndex: number;
    eventOffset: number;
    logOffset: number;
}

export type SelectionKey = 'run' | 'pipeline' | 'editor' | 'history' | 'trigger' | 'approval';

export type UiStateMachineEvent =
    | { type: 'switch_tab'; tab: TabId }
    | { type: 'toggle_help' }
    | { type: 'set_status'; text: string; tone?: StatusTone }
    | { type: 'set_focus'; zone: FocusZone }
    | { type: 'cycle_focus'; reverse?: boolean }
    | { type: 'open_palette' }
    | { type: 'close_palette' }
    | { type: 'palette_query'; query: string }
    | { type: 'palette_move'; delta: number; max: number }
    | { type: 'open_prompt'; title: string; value: string; description?: string }
    | { type: 'close_prompt' }
    | { type: 'prompt_set'; value: string }
    | { type: 'open_confirm'; title: string; body: string; actionKey: string }
    | { type: 'close_confirm' }
    | { type: 'select_index'; key: SelectionKey; index: number; max: number }
    | { type: 'move_index'; key: SelectionKey; delta: number; max: number }
    | { type: 'scroll_events'; delta: number }
    | { type: 'scroll_logs'; delta: number };

export type PaletteCategory = 'tab' | 'action' | 'entity';

export interface CommandPaletteItem {
    id: string;
    label: string;
    hint: string;
    category: PaletteCategory;
    keywords: string[];
    event: UiStateMachineEvent;
    followUpEvent?: UiStateMachineEvent;
}
