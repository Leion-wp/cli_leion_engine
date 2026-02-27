import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type PipelinesScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    pipelines: any[];
    selectedPipelineIndex: number;
    filterQuery: string;
};

export function PipelinesScreen(props: PipelinesScreenProps): JSX.Element {
    const selectedPipeline = props.pipelines[props.selectedPipelineIndex];
    const stacked = props.layoutMode === 'stack';

    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`Pipelines (${props.pipelines.length})`} theme={props.theme} width={stacked ? undefined : '45%'} marginRight={stacked ? 0 : 1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k, Enter/r run, d dry-run, n new, x delete, e editor, g/G jump</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {props.pipelines.slice(0, 36).map((entry, index) => {
                    const selected = index === props.selectedPipelineIndex;
                    const id = String(entry?.path || entry?.name || index);
                    return (
                        <Text key={id} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.name || '?')}
                        </Text>
                    );
                })}
                {props.pipelines.length === 0 && <Text color={props.theme.colors.muted}>Aucun pipeline visible (ajuste le filtre F).</Text>}
            </Panel>

            <Panel title="Détail Pipeline" theme={props.theme} width={stacked ? undefined : '55%'} active={props.focusZone === 'right'}>
                <Text>name: {String(selectedPipeline?.name || '-')}</Text>
                <Text>path: {String(selectedPipeline?.path || '-')}</Text>
                <Text color={props.theme.colors.muted}>Actions directes: run detached/dry-run/édition.</Text>
            </Panel>
        </Box>
    );
}
