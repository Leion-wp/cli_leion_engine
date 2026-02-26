import * as fs from 'fs';
import * as path from 'path';

type FlatConfig = Record<string, any>;

function flatten(prefix: string, input: any, out: FlatConfig): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        out[prefix] = input;
        return;
    }
    for (const [key, value] of Object.entries(input)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flatten(nextPrefix, value, out);
            continue;
        }
        out[nextPrefix] = value;
    }
}

export function loadWorkspaceConfig(workspaceRoot: string): FlatConfig {
    const configPath = path.join(workspaceRoot, '.intent-router', 'config.json');
    if (!fs.existsSync(configPath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const entries: FlatConfig = {};
        if (parsed && typeof parsed === 'object' && parsed.intentRouter && typeof parsed.intentRouter === 'object') {
            flatten('intentRouter', parsed.intentRouter, entries);
            if ((parsed as any).leionRoots && typeof (parsed as any).leionRoots === 'object') {
                flatten('leionRoots', (parsed as any).leionRoots, entries);
            }
            return entries;
        }
        for (const [key, value] of Object.entries(parsed || {})) {
            if (key.startsWith('intentRouter.') || key.startsWith('leionRoots.')) {
                entries[key] = value;
                continue;
            }
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                flatten(`intentRouter.${key}`, value, entries);
            } else {
                entries[`intentRouter.${key}`] = value;
            }
        }
        return entries;
    } catch {
        return {};
    }
}

export function getConfigValue<T>(workspaceRoot: string, fullKey: string, fallback: T): T {
    const entries = loadWorkspaceConfig(workspaceRoot);
    if (Object.prototype.hasOwnProperty.call(entries, fullKey)) {
        return entries[fullKey] as T;
    }
    return fallback;
}

