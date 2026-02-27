import { FocusZone, TabId, TuiKeymapProfile } from './types';
import { TAB_SHORTCUTS } from './machines';

export type InkLikeKey = {
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    tab?: boolean;
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
};

export type GlobalKeyAction =
    | { type: 'none' }
    | { type: 'quit' }
    | { type: 'toggle_help' }
    | { type: 'open_palette' }
    | { type: 'switch_tab'; tab: TabId }
    | { type: 'switch_tab_relative'; delta: -1 | 1 }
    | { type: 'cycle_focus'; reverse?: boolean }
    | { type: 'move_up' }
    | { type: 'move_down' }
    | { type: 'confirm' }
    | { type: 'cancel' }
    | { type: 'input_char'; value: string }
    | { type: 'backspace' };

export function resolveGlobalKeyAction(input: string, key: InkLikeKey, profile: TuiKeymapProfile, paletteEnabled: boolean): GlobalKeyAction {
    if ((key.ctrl && input === 'c') || input === 'q') return { type: 'quit' };
    if (input === '?') return { type: 'toggle_help' };

    // Many terminals don't expose Shift+Arrow as a distinct modifier in TUI mode.
    // We accept both Shift+Arrow and plain Left/Right for deterministic tab switching.
    if (key.shift && key.leftArrow) return { type: 'switch_tab_relative', delta: -1 };
    if (key.shift && key.rightArrow) return { type: 'switch_tab_relative', delta: 1 };
    if (key.leftArrow) return { type: 'switch_tab_relative', delta: -1 };
    if (key.rightArrow) return { type: 'switch_tab_relative', delta: 1 };

    if (paletteEnabled && key.ctrl && input.toLowerCase() === 'k') {
        return { type: 'open_palette' };
    }

    const tab = TAB_SHORTCUTS[input];
    if (tab) return { type: 'switch_tab', tab };

    if (key.tab) {
        return { type: 'cycle_focus', reverse: key.shift === true };
    }

    if (key.upArrow || (profile === 'hybrid' && input === 'k')) return { type: 'move_up' };
    if (key.downArrow || (profile === 'hybrid' && input === 'j')) return { type: 'move_down' };

    if (key.return) return { type: 'confirm' };
    if (key.escape) return { type: 'cancel' };
    if (key.backspace || key.delete) return { type: 'backspace' };

    if (!key.ctrl && !key.meta && input && input.length === 1) {
        return { type: 'input_char', value: input };
    }

    return { type: 'none' };
}

export function defaultFocusForTab(tab: TabId): FocusZone {
    if (tab === 'run') return 'left';
    if (tab === 'diff') return 'center';
    return 'left';
}
