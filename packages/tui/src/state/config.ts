import * as fs from 'fs';
import * as path from 'path';
import {
    TuiRuntimeConfig,
    TuiThemeName,
    TuiKeymapProfile,
    UiVersion
} from './types';

function toPositiveInt(input: unknown, fallback: number): number {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function readPath<T = unknown>(source: any, pathKeys: string[]): T | undefined {
    let current = source;
    for (const key of pathKeys) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current as T;
}

function readFlat<T = unknown>(source: any, key: string): T | undefined {
    if (!source || typeof source !== 'object') return undefined;
    return source[key] as T;
}

function normalizeUiVersion(input: unknown): UiVersion {
    const value = String(input || '').trim().toLowerCase();
    if (value === 'legacy') return 'legacy';
    return 'v2';
}

function normalizeThemeName(input: unknown): TuiThemeName {
    const value = String(input || '').trim().toLowerCase();
    if (value === 'leion-pro') return 'leion-pro';
    return 'leion-pro';
}

function normalizeBoolean(input: unknown, fallback: boolean): boolean {
    if (typeof input === 'boolean') return input;
    if (typeof input === 'string') {
        const lower = input.trim().toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') return true;
        if (lower === 'false' || lower === '0' || lower === 'no') return false;
    }
    return fallback;
}

function normalizeKeymapProfile(input: unknown): TuiKeymapProfile {
    const value = String(input || '').trim().toLowerCase();
    if (value === 'classic') return 'classic';
    return 'hybrid';
}

function normalizePaletteTrigger(input: unknown): 'ctrl+k' {
    const value = String(input || '').trim().toLowerCase();
    if (value === 'ctrl+k' || value === 'ctrlk') return 'ctrl+k';
    return 'ctrl+k';
}

export function loadTuiConfig(workspaceRoot: string): TuiRuntimeConfig {
    const configPath = path.join(workspaceRoot, '.intent-router', 'config.json');
    let parsed: any = {};
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        parsed = {};
    }

    const maxLogs = toPositiveInt(
        readPath(parsed, ['intentRouter', 'tui', 'logs', 'maxLines'])
            ?? readFlat(parsed, 'intentRouter.tui.logs.maxLines'),
        2000
    );

    const maxEvents = toPositiveInt(
        readPath(parsed, ['intentRouter', 'tui', 'events', 'maxItems'])
            ?? readFlat(parsed, 'intentRouter.tui.events.maxItems'),
        5000
    );

    const uiVersion = normalizeUiVersion(
        readPath(parsed, ['intentRouter', 'tui', 'ui', 'version'])
            ?? readFlat(parsed, 'intentRouter.tui.ui.version')
    );

    const themeName = normalizeThemeName(
        readPath(parsed, ['intentRouter', 'tui', 'theme', 'name'])
            ?? readFlat(parsed, 'intentRouter.tui.theme.name')
    );

    const highContrast = normalizeBoolean(
        readPath(parsed, ['intentRouter', 'tui', 'theme', 'highContrast'])
            ?? readFlat(parsed, 'intentRouter.tui.theme.highContrast'),
        false
    );

    const keymapProfile = normalizeKeymapProfile(
        readPath(parsed, ['intentRouter', 'tui', 'keymap', 'profile'])
            ?? readFlat(parsed, 'intentRouter.tui.keymap.profile')
    );

    const paletteEnabled = normalizeBoolean(
        readPath(parsed, ['intentRouter', 'tui', 'palette', 'enabled'])
            ?? readFlat(parsed, 'intentRouter.tui.palette.enabled'),
        true
    );

    const paletteTrigger = normalizePaletteTrigger(
        readPath(parsed, ['intentRouter', 'tui', 'palette', 'trigger'])
            ?? readFlat(parsed, 'intentRouter.tui.palette.trigger')
    );

    return {
        maxLogs,
        maxEvents,
        ui: {
            version: uiVersion
        },
        theme: {
            name: themeName,
            highContrast
        },
        keymap: {
            profile: keymapProfile
        },
        palette: {
            enabled: paletteEnabled,
            trigger: paletteTrigger
        }
    };
}
