import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { formatTime } from '../services/formatters';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type HistoryScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    historyRows: any[];
    selectedHistoryIndex: number;
};

export function HistoryScreen(props: HistoryScreenProps): JSX.Element {
    const selectedHistory = props.historyRows[props.selectedHistoryIndex];

    return (
        <Box marginTop={1}>
            <Panel title={`Historique (${props.historyRows.length})`} theme={props.theme} width="45%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k, jump rapide vers Diff/Run via palette</Text>
                {props.historyRows.slice(0, 30).map((entry, index) => {
                    const selected = index === props.selectedHistoryIndex;
                    const key = String(entry?.id || index);
                    return (
                        <Text key={key} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.id || '?')} [{String(entry?.status || '-')}] {formatTime(entry?.timestamp)}
                        </Text>
                    );
                })}
            </Panel>

            <Panel title="Détail Run" theme={props.theme} width="55%" active={props.focusZone === 'right'}>
                <Text>id: {String(selectedHistory?.id || '-')}</Text>
                <Text>name: {String(selectedHistory?.name || '-')}</Text>
                <Text>status: {String(selectedHistory?.status || '-')}</Text>
                <Text>steps: {String(Array.isArray(selectedHistory?.steps) ? selectedHistory.steps.length : 0)}</Text>
                <Text color={props.theme.colors.muted}>Action conseillée: ouvrir Diff (tab 5) pour audit rapide.</Text>
            </Panel>
        </Box>
    );
}
