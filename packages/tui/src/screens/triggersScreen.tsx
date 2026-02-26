import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type TriggersScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    triggerRows: any[];
    selectedTriggerIndex: number;
};

export function TriggersScreen(props: TriggersScreenProps): JSX.Element {
    const selectedTrigger = props.triggerRows[props.selectedTriggerIndex];

    return (
        <Box marginTop={1}>
            <Panel title={`Triggers (${props.triggerRows.length})`} theme={props.theme} width="45%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k | s start | x stop | f refresh</Text>
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
            </Panel>

            <Panel title="Détail Trigger" theme={props.theme} width="55%" active={props.focusZone === 'right'}>
                <Text>id: {String(selectedTrigger?.id || '-')}</Text>
                <Text>intent: {String(selectedTrigger?.intent || '-')}</Text>
                <Text>enabled: {String(selectedTrigger?.enabled === true)}</Text>
                <Text>pipeline: {String(selectedTrigger?.pipelineName || '-')}</Text>
            </Panel>
        </Box>
    );
}
