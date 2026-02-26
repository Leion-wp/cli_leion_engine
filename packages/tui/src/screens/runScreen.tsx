import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { toneColor, Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type RunScreenProps = {
    theme: TuiTheme;
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
};

export function RunScreen(props: RunScreenProps): JSX.Element {
    return (
        <Box marginTop={1}>
            <Panel title={`Cockpit Runs (${props.runs.length})`} theme={props.theme} width="32%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>Focus: liste runs | ↑/↓ ou j/k | Enter actions</Text>
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
            </Panel>

            <Panel title={`Timeline Events ${props.eventTotal}/${props.eventMax}`} theme={props.theme} width="38%" marginRight={1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>Filtre: global via palette | Scroll: [ / ] | Offset: {props.eventOffset}</Text>
                {props.visibleEvents.length === 0 && <Text color={props.theme.colors.muted}>Aucun event pour ce run.</Text>}
                {props.visibleEvents.map((line, index) => (
                    <Text key={`ev-${index}`}>{line}</Text>
                ))}
            </Panel>

            <Panel title={`Live Logs ${props.logTotal}/${props.logMax}`} theme={props.theme} width="30%" active={props.focusZone === 'right'}>
                <Text color={props.theme.colors.muted}>Actions run: p pause, r resume, c cancel | Scroll: {"{ / }"} | Offset: {props.logOffset}</Text>
                {props.visibleLogs.length === 0 && <Text color={props.theme.colors.muted}>Aucun log.</Text>}
                {props.visibleLogs.map((line, index) => (
                    <Text key={`log-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
