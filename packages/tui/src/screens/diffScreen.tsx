import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type DiffScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    source: 'audit' | 'git' | 'none';
    lines: string[];
};

export function DiffScreen(props: DiffScreenProps): JSX.Element {
    const files = props.lines.filter((line) => line.startsWith('file:') || line.startsWith('M ') || line.startsWith('A ') || line.startsWith('D '));
    return (
        <Box marginTop={1}>
            <Panel title={`Diff Source: ${props.source}`} theme={props.theme} width="35%" marginRight={1} active={props.focusZone === 'center'}>
                <Text color={props.theme.colors.muted}>f refresh, ouverture runs via History</Text>
                {files.length === 0 && <Text color={props.theme.colors.muted}>Aucun fichier détecté.</Text>}
                {files.slice(0, 30).map((line, index) => (
                    <Text key={`file-${index}`}>{line}</Text>
                ))}
            </Panel>

            <Panel title="Aperçu Diff" theme={props.theme} width="65%" active={props.focusZone === 'right'}>
                {props.lines.length === 0 && <Text color={props.theme.colors.muted}>No diff data available.</Text>}
                {props.lines.slice(0, 45).map((line, index) => (
                    <Text key={`diff-${index}`}>{line}</Text>
                ))}
            </Panel>
        </Box>
    );
}
