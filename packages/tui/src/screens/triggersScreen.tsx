import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type TriggersScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    triggerRows: any[];
    selectedTriggerIndex: number;
    filterQuery: string;
};

export function TriggersScreen(props: TriggersScreenProps): JSX.Element {
    const selectedTrigger = props.triggerRows[props.selectedTriggerIndex];
    const stacked = props.layoutMode === 'stack';

    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`Triggers (${props.triggerRows.length})`} theme={props.theme} width={stacked ? undefined : '45%'} marginRight={stacked ? 0 : 1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k | g/G jump | s start | x stop | f refresh</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {props.triggerRows.slice(0, 30).map((entry, index) => {
                    const selected = index === props.selectedTriggerIndex;
                    const key = String(entry?.id || index);
                    const enabled = entry?.enabled === true ? 'enabled' : 'disabled';
                    return (
                        <Text key={key} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.kind || '?')} {String(entry?.pipelineName || '-')}::{String(entry?.stepId || '-')} [{enabled}]
                        </Text>
                    );
                })}
                {props.triggerRows.length === 0 && <Text color={props.theme.colors.muted}>Aucun trigger visible (ajuste le filtre F).</Text>}
            </Panel>

            <Panel title="Détail Trigger" theme={props.theme} width={stacked ? undefined : '55%'} active={props.focusZone === 'right'}>
                <Text>id: {String(selectedTrigger?.id || '-')}</Text>
                <Text>intent: {String(selectedTrigger?.intent || '-')}</Text>
                <Text>enabled: {String(selectedTrigger?.enabled === true)}</Text>
                <Text>pipeline: {String(selectedTrigger?.pipelineName || '-')}</Text>
            </Panel>
        </Box>
    );
}
