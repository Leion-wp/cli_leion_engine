#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app';

type ParsedArgs = {
    workspaceRoot: string;
    runId?: string;
    pipeline?: string;
    legacy?: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
    const flags: Record<string, string | boolean> = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            index += 1;
        } else {
            flags[key] = true;
        }
    }

    const workspaceRoot = String(flags.workspace || process.cwd()).trim() || process.cwd();
    return {
        workspaceRoot,
        runId: String(flags.run_id || '').trim() || undefined,
        pipeline: String(flags.pipeline || '').trim() || undefined,
        legacy: Boolean(flags.legacy)
    };
}

function main(): void {
    if (!process.stdout.isTTY) {
        process.stderr.write('Leion TUI requires an interactive TTY terminal.\n');
        process.exit(2);
    }
    process.env.LEION_SILENT_PROVIDER_LOGS = '1';
    const parsed = parseArgs(process.argv.slice(2));
    render(
        <App
            workspaceRoot={parsed.workspaceRoot}
            initialRunId={parsed.runId}
            initialPipeline={parsed.pipeline}
            legacyMode={parsed.legacy}
        />
    );
}

main();
