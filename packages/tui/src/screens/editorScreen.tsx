import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type EditorScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    pipelinePath: string;
    nodes: any[];
    selectedNodeIndex: number;
    yamlPreview: string[];
};

function valueToText(value: unknown): string {
    if (value === undefined || value === null) return '-';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

export function EditorScreen(props: EditorScreenProps): JSX.Element {
    const selectedNode = props.nodes[props.selectedNodeIndex];

    return (
        <Box marginTop={1}>
            <Panel title={`Editor Nodes (${props.nodes.length})`} theme={props.theme} width="35%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ | a add | x delete | u/j reorder | i/m/o/c fields | y yaml | v pipeline yaml</Text>
                {props.nodes.slice(0, 35).map((entry, index) => {
                    const selected = index === props.selectedNodeIndex;
                    const id = String(entry?.id || index);
                    return (
                        <Text key={id} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.id || '?')} :: {String(entry?.intent || entry?.type || '-')}
                        </Text>
                    );
                })}
            </Panel>

            <Panel title="Inspector Intelligent" theme={props.theme} width="35%" marginRight={1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>pipeline: {props.pipelinePath || '-'}</Text>
                <Text>id: {valueToText(selectedNode?.id)}</Text>
                <Text>type: {valueToText(selectedNode?.type)}</Text>
                <Text>intent: {valueToText(selectedNode?.intent)}</Text>
                <Text>description: {valueToText(selectedNode?.description)}</Text>
                <Text>onFailure: {valueToText(selectedNode?.onFailure)}</Text>
                <Text>payload.command: {valueToText(selectedNode?.payload?.command)}</Text>
                <Text color={props.theme.colors.muted}>Form contextuel via prompt inline + validation service.</Text>
            </Panel>

            <Panel title="YAML Preview" theme={props.theme} width="30%" active={props.focusZone === 'right'}>
                {props.yamlPreview.length === 0 && <Text color={props.theme.colors.muted}>Sélectionne un node pour preview YAML.</Text>}
                {props.yamlPreview.slice(0, 28).map((line, index) => (
                    <Text key={`yaml-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
