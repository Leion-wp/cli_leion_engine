import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type PipelinesScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    pipelines: any[];
    selectedPipelineIndex: number;
};

export function PipelinesScreen(props: PipelinesScreenProps): JSX.Element {
    const selectedPipeline = props.pipelines[props.selectedPipelineIndex];

    return (
        <Box marginTop={1}>
            <Panel title={`Pipelines (${props.pipelines.length})`} theme={props.theme} width="45%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k, Enter/r run, d dry-run, n new, x delete, e editor</Text>
                {props.pipelines.slice(0, 36).map((entry, index) => {
                    const selected = index === props.selectedPipelineIndex;
                    const id = String(entry?.path || entry?.name || index);
                    return (
                        <Text key={id} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.name || '?')}
                        </Text>
                    );
                })}
            </Panel>

            <Panel title="Détail Pipeline" theme={props.theme} width="55%" active={props.focusZone === 'right'}>
                <Text>name: {String(selectedPipeline?.name || '-')}</Text>
                <Text>path: {String(selectedPipeline?.path || '-')}</Text>
                <Text color={props.theme.colors.muted}>Actions directes: run detached/dry-run/édition.</Text>
            </Panel>
        </Box>
    );
}
