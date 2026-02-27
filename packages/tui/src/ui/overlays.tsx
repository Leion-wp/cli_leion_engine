import React from 'react';
import { Box, Text } from 'ink';
import { TuiTheme } from './theme';

export function HelpOverlay(props: { theme: TuiTheme }): JSX.Element {
    return (
        <Box borderStyle="double" borderColor={props.theme.colors.accentAlt} paddingX={1} flexDirection="column" marginTop={1}>
            <Text color={props.theme.colors.accent}>Aide clavier (hybrid)</Text>
            <Text color={props.theme.colors.muted}>Navigation globale</Text>
            <Text color={props.theme.colors.muted}>[1..7] tab direct  [Shift+Left/Right] tab suivant/précédent  [Tab] changer focus</Text>
            <Text color={props.theme.colors.muted}>[Ctrl+K ou /] palette  [F] filtre tab  [C] clear filtre  [R] refresh tab  [g/G] jump</Text>
            <Text color={props.theme.colors.muted}>[?] aide  [q] quitter</Text>
            <Text color={props.theme.colors.muted}>Actions métier</Text>
            <Text color={props.theme.colors.muted}>Run: [p] pause [r] resume [c] cancel | Diff: [f] refresh | Triggers: [s/x/f] | HITL: [a/r]</Text>
        </Box>
    );
}

export function PromptOverlay(props: {
    theme: TuiTheme;
    title: string;
    value: string;
    description?: string;
}): JSX.Element {
    return (
        <Box borderStyle="double" borderColor={props.theme.colors.accent} paddingX={1} flexDirection="column" marginTop={1}>
            <Text color={props.theme.colors.accent}>{props.title}</Text>
            {props.description && <Text color={props.theme.colors.muted}>{props.description}</Text>}
            <Text>{props.value}</Text>
            <Text color={props.theme.colors.muted}>Enter confirmer | Esc annuler</Text>
        </Box>
    );
}

export function ConfirmOverlay(props: {
    theme: TuiTheme;
    title: string;
    body: string;
}): JSX.Element {
    return (
        <Box borderStyle="double" borderColor={props.theme.colors.warn} paddingX={1} flexDirection="column" marginTop={1}>
            <Text color={props.theme.colors.warn}>{props.title}</Text>
            <Text>{props.body}</Text>
            <Text color={props.theme.colors.muted}>Enter confirmer | Esc annuler</Text>
        </Box>
    );
}
