import React from 'react';
import { Box, Text } from 'ink';
import { TabId } from '../state/types';
import { TuiTheme } from './theme';

type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

type PanelProps = {
    title: string;
    theme: TuiTheme;
    active?: boolean;
    width?: string;
    marginRight?: number;
    children: React.ReactNode;
};

export function toneColor(theme: TuiTheme, tone: Tone): string {
    if (tone === 'ok') return theme.colors.ok;
    if (tone === 'warn') return theme.colors.warn;
    if (tone === 'err') return theme.colors.err;
    if (tone === 'info') return theme.colors.info;
    return theme.colors.muted;
}

export function Badge(props: { tone: Tone; label: string; theme: TuiTheme }): JSX.Element {
    const symbol = props.tone === 'ok'
        ? props.theme.symbols.ok
        : props.tone === 'warn'
            ? props.theme.symbols.warn
            : props.tone === 'err'
                ? props.theme.symbols.err
                : props.theme.symbols.info;
    return (
        <Text color={toneColor(props.theme, props.tone)}>
            {symbol} {props.label}
        </Text>
    );
}

export function Panel(props: PanelProps): JSX.Element {
    return (
        <Box
            flexDirection="column"
            width={props.width}
            borderStyle="round"
            borderColor={props.active ? props.theme.colors.panelBorderActive : props.theme.colors.panelBorder}
            paddingX={1}
            marginRight={props.marginRight}
        >
            <Text color={props.active ? props.theme.colors.accent : props.theme.colors.accentAlt}>{props.title}</Text>
            {props.children}
        </Box>
    );
}

export function EmptyLine(props: { text: string; theme: TuiTheme }): JSX.Element {
    return <Text color={props.theme.colors.muted}>{props.text}</Text>;
}

const TAB_ORDER: Array<{ id: TabId; label: string; key: string }> = [
    { id: 'run', label: 'Run', key: '1' },
    { id: 'pipelines', label: 'Pipelines', key: '2' },
    { id: 'editor', label: 'Editor', key: '3' },
    { id: 'history', label: 'History', key: '4' },
    { id: 'diff', label: 'Diff', key: '5' },
    { id: 'triggers', label: 'Triggers', key: '6' },
    { id: 'hitl', label: 'HITL', key: '7' }
];

type TabCount = {
    visible: number;
    total: number;
    filtered: boolean;
};

function formatTabLabel(baseLabel: string, count?: TabCount): string {
    if (!count) return baseLabel;
    if (count.filtered) return `${baseLabel} ${count.visible}/${count.total}`;
    return `${baseLabel} ${count.total}`;
}

export function TabBar(props: { activeTab: TabId; theme: TuiTheme; counts?: Partial<Record<TabId, TabCount>> }): JSX.Element {
    return (
        <Box borderStyle="round" borderColor={props.theme.colors.panelBorder} paddingX={1} marginTop={1} flexDirection="column">
            <Box>
            {TAB_ORDER.map((entry) => {
                const active = entry.id === props.activeTab;
                const count = active ? props.counts?.[entry.id] : undefined;
                return (
                    <Box key={entry.id} marginRight={1}>
                        <Text
                            color={active ? props.theme.colors.tabActiveFg : props.theme.colors.accent}
                            backgroundColor={active ? props.theme.colors.tabActiveBg : undefined}
                        >
                            {entry.key} {formatTabLabel(entry.label, count)}
                        </Text>
                    </Box>
                );
            })}
            </Box>
            <Text color={props.theme.colors.muted}>
                Active: {props.activeTab.toUpperCase()} {props.theme.symbols.separator} Shift+Left/Right: switch tab
            </Text>
        </Box>
    );
}

export function KeybindStrip(props: {
    theme: TuiTheme;
    title: string;
    items: Array<{ key: string; label: string }>;
}): JSX.Element {
    return (
        <Box borderStyle="round" borderColor={props.theme.colors.panelBorder} paddingX={1} marginTop={1} flexDirection="column">
            <Text color={props.theme.colors.accent}>{props.title}</Text>
            <Box marginTop={0}>
                {props.items.map((entry) => (
                    <Box key={`${entry.key}:${entry.label}`} marginRight={2}>
                        <Text color={props.theme.colors.tabActiveFg} backgroundColor={props.theme.colors.tabActiveBg}> {entry.key} </Text>
                        <Text color={props.theme.colors.muted}> {entry.label}</Text>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

export function Header(props: {
    theme: TuiTheme;
    workspaceRoot: string;
    selectedRunId: string;
    selectedRunStatus: string;
    uiVersion: string;
}): JSX.Element {
    const normalized = props.selectedRunStatus.trim().toLowerCase();
    const statusTone: Tone = normalized === 'running' || normalized === 'success'
        ? 'ok'
        : normalized === 'failure' || normalized === 'cancelled'
            ? 'err'
            : normalized.includes('pause')
                ? 'warn'
                : 'info';

    return (
        <Box borderStyle="round" borderColor={props.theme.colors.panelBorderActive} paddingX={1}>
            <Box flexDirection="column" flexGrow={1}>
                <Text color={props.theme.colors.accent}>LEION ROOTS TUI V2</Text>
                <Text color={props.theme.colors.muted}>Workspace: {props.workspaceRoot}</Text>
                <Text color={props.theme.colors.muted}>Mode: {props.uiVersion}</Text>
            </Box>
            <Box flexDirection="column" alignItems="flex-end">
                <Badge tone={statusTone} label={(props.selectedRunStatus || 'idle').toUpperCase()} theme={props.theme} />
                <Text color={props.theme.colors.muted}>Run: {props.selectedRunId || '-'}</Text>
            </Box>
        </Box>
    );
}

export function Footer(props: {
    theme: TuiTheme;
    statusText: string;
    tone: Tone;
    helpHint: string;
    keybinds: Array<{ key: string; label: string }>;
}): JSX.Element {
    return (
        <Box borderStyle="round" borderColor={props.theme.colors.panelBorder} paddingX={1} marginTop={1} flexDirection="column">
            <Text color={toneColor(props.theme, props.tone)}>{props.statusText}</Text>
            <Box marginTop={0}>
                {props.keybinds.map((entry) => (
                    <Box key={`${entry.key}:${entry.label}`} marginRight={1}>
                        <Text color={props.theme.colors.tabActiveFg} backgroundColor={props.theme.colors.tabActiveBg}> {entry.key} </Text>
                        <Text color={props.theme.colors.muted}> {entry.label}</Text>
                    </Box>
                ))}
            </Box>
            <Text color={props.theme.colors.muted}>{props.helpHint}</Text>
        </Box>
    );
}
