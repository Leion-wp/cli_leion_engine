import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { toneColor, Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type RunScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    runs: any[];
    selectedRunIndex: number;
    visibleEvents: string[];
    visibleLogs: string[];
    eventTotal: number;
    eventMax: number;
    logTotal: number;
    logMax: number;
    eventOffset: number;
    logOffset: number;
    filterQuery: string;
};

export function RunScreen(props: RunScreenProps): JSX.Element {
    const stacked = props.layoutMode !== 'wide';
    const leftWidth = props.layoutMode === 'wide' ? '32%' : props.layoutMode === 'compact' ? '42%' : undefined;
    const centerWidth = props.layoutMode === 'wide' ? '38%' : props.layoutMode === 'compact' ? '58%' : undefined;
    const rightWidth = props.layoutMode === 'wide' ? '30%' : undefined;

    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`Cockpit Runs (${props.runs.length})`} theme={props.theme} width={leftWidth} marginRight={stacked ? 0 : 1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>Focus: liste runs | ↑/↓ ou j/k | g/G jump | Enter actions</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {props.runs.slice(0, 24).map((entry, index) => {
                    const selected = index === props.selectedRunIndex;
                    const status = String(entry?.status || '-');
                    const id = String(entry?.detachedRunId || entry?.pipelineRunId || '?');
                    return (
                        <Text key={id} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {id} <Text color={toneColor(props.theme, status === 'running' ? 'ok' : status === 'failure' ? 'err' : 'info')}>[{status}]</Text>
                        </Text>
                    );
                })}
                {props.runs.length === 0 && <Text color={props.theme.colors.muted}>Aucun run visible (ajuste le filtre F).</Text>}
            </Panel>

            <Panel title={`Timeline Events ${props.eventTotal}/${props.eventMax}`} theme={props.theme} width={centerWidth} marginRight={stacked ? 0 : 1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>Filtre: global via palette | Scroll: [ / ] | Offset: {props.eventOffset}</Text>
                {props.visibleEvents.length === 0 && <Text color={props.theme.colors.muted}>Aucun event pour ce run.</Text>}
                {props.visibleEvents.map((line, index) => (
                    <Text key={`ev-${index}`}>{line}</Text>
                ))}
            </Panel>

            <Panel title={`Live Logs ${props.logTotal}/${props.logMax}`} theme={props.theme} width={rightWidth} active={props.focusZone === 'right'}>
                <Text color={props.theme.colors.muted}>Actions run: p pause, r resume, c cancel | Scroll: {"{ / }"} | Offset: {props.logOffset}</Text>
                {props.visibleLogs.length === 0 && <Text color={props.theme.colors.muted}>Aucun log.</Text>}
                {props.visibleLogs.map((line, index) => (
                    <Text key={`log-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
