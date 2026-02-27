import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type EditorScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    pipelinePath: string;
    nodes: any[];
    selectedNodeIndex: number;
    yamlPreview: string[];
    filterQuery: string;
};

function valueToText(value: unknown): string {
    if (value === undefined || value === null) return '-';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

export function EditorScreen(props: EditorScreenProps): JSX.Element {
    const selectedNode = props.nodes[props.selectedNodeIndex];
    const stacked = props.layoutMode !== 'wide';
    const leftWidth = props.layoutMode === 'wide' ? '35%' : props.layoutMode === 'compact' ? '45%' : undefined;
    const centerWidth = props.layoutMode === 'wide' ? '35%' : props.layoutMode === 'compact' ? '55%' : undefined;
    const rightWidth = props.layoutMode === 'wide' ? '30%' : undefined;

    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`Editor Nodes (${props.nodes.length})`} theme={props.theme} width={leftWidth} marginRight={stacked ? 0 : 1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ | a add | x delete | u/j reorder | i/m/o/c fields | y yaml | v pipeline yaml | g/G jump</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {props.nodes.slice(0, 35).map((entry, index) => {
                    const selected = index === props.selectedNodeIndex;
                    const id = String(entry?.id || index);
                    return (
                        <Text key={id} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.id || '?')} :: {String(entry?.intent || entry?.type || '-')}
                        </Text>
                    );
                })}
                {props.nodes.length === 0 && <Text color={props.theme.colors.muted}>Aucun node visible (ajuste le filtre F).</Text>}
            </Panel>

            <Panel title="Inspector Intelligent" theme={props.theme} width={centerWidth} marginRight={stacked ? 0 : 1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>pipeline: {props.pipelinePath || '-'}</Text>
                <Text>id: {valueToText(selectedNode?.id)}</Text>
                <Text>type: {valueToText(selectedNode?.type)}</Text>
                <Text>intent: {valueToText(selectedNode?.intent)}</Text>
                <Text>description: {valueToText(selectedNode?.description)}</Text>
                <Text>onFailure: {valueToText(selectedNode?.onFailure)}</Text>
                <Text>payload.command: {valueToText(selectedNode?.payload?.command)}</Text>
                <Text color={props.theme.colors.muted}>Form contextuel via prompt inline + validation service.</Text>
            </Panel>

            <Panel title="YAML Preview" theme={props.theme} width={rightWidth} active={props.focusZone === 'right'}>
                {props.yamlPreview.length === 0 && <Text color={props.theme.colors.muted}>Sélectionne un node pour preview YAML.</Text>}
                {props.yamlPreview.slice(0, 28).map((line, index) => (
                    <Text key={`yaml-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
