import React from 'react';
import { Box, Text } from 'ink';
import { TuiTheme } from './theme';

export function HelpOverlay(props: { theme: TuiTheme }): JSX.Element {
    return (
        <Box borderStyle="double" borderColor={props.theme.colors.accentAlt} paddingX={1} flexDirection="column" marginTop={1}>
            <Text color={props.theme.colors.accent}>Aide clavier (hybrid)</Text>
            <Text color={props.theme.colors.muted}>Tabs: 1..7 | Focus: Tab / Shift+Tab | Quit: q or Ctrl+C | Help: ?</Text>
            <Text color={props.theme.colors.muted}>Navigation: ↑/↓ ou j/k | Palette: Ctrl+K | Prompt: Enter/Esc</Text>
            <Text color={props.theme.colors.muted}>Run: p pause, r resume, c cancel | Diff: f refresh | Triggers: s/x/f | HITL: a/r</Text>
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
