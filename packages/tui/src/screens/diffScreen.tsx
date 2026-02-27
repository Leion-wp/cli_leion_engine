import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type DiffScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    source: 'audit' | 'git' | 'none';
    lines: string[];
    filterQuery: string;
};

export function DiffScreen(props: DiffScreenProps): JSX.Element {
    const files = props.lines.filter((line) => line.startsWith('file:') || line.startsWith('M ') || line.startsWith('A ') || line.startsWith('D '));
    const stacked = props.layoutMode === 'stack';
    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`Diff Source: ${props.source}`} theme={props.theme} width={stacked ? undefined : '35%'} marginRight={stacked ? 0 : 1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>f refresh, ouverture runs via History</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {files.length === 0 && <Text color={props.theme.colors.muted}>Aucun fichier détecté.</Text>}
                {files.slice(0, 30).map((line, index) => (
                    <Text key={`file-${index}`}>{line}</Text>
                ))}
            </Panel>

            <Panel title="Aperçu Diff" theme={props.theme} width={stacked ? undefined : '65%'} active={props.focusZone === 'right'}>
                {props.lines.length === 0 && <Text color={props.theme.colors.muted}>No diff data available.</Text>}
                {props.lines.slice(0, 45).map((line, index) => (
                    <Text key={`diff-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
