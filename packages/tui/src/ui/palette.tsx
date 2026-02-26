import React from 'react';
import { Box, Text } from 'ink';
import { CommandPaletteItem } from '../state/types';
import { TuiTheme } from './theme';

export function CommandPalette(props: {
    theme: TuiTheme;
    query: string;
    items: CommandPaletteItem[];
    selectedIndex: number;
}): JSX.Element {
    return (
        <Box borderStyle="double" borderColor={props.theme.colors.paletteBorder} paddingX={1} flexDirection="column" marginTop={1}>
            <Text color={props.theme.colors.accent}>Command Palette (Ctrl+K)</Text>
            <Text color={props.theme.colors.muted}>Recherche: {props.query || '(vide)'}</Text>
            {props.items.length === 0 && <Text color={props.theme.colors.muted}>Aucun résultat.</Text>}
            {props.items.slice(0, 12).map((item, index) => {
                const active = index === props.selectedIndex;
                return (
                    <Text key={item.id} color={active ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                        {active ? props.theme.symbols.pointer : ' '} {item.label} <Text color={props.theme.colors.muted}>[{item.hint}]</Text>
                    </Text>
                );
            })}
        </Box>
    );
}
