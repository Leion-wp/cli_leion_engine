import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { LayoutMode } from '../ui/layout';
import { TuiTheme } from '../ui/theme';

type HitlScreenProps = {
    theme: TuiTheme;
    layoutMode: LayoutMode;
    focusZone: FocusZone;
    approvals: any[];
    selectedApprovalIndex: number;
    filterQuery: string;
};

export function HitlScreen(props: HitlScreenProps): JSX.Element {
    const selectedApproval = props.approvals[props.selectedApprovalIndex];
    const stacked = props.layoutMode === 'stack';

    return (
        <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
            <Panel title={`HITL Inbox (${props.approvals.length})`} theme={props.theme} width={stacked ? undefined : '45%'} marginRight={stacked ? 0 : 1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k | g/G jump | a approve | r reject</Text>
                <Text color={props.theme.colors.muted}>Filtre tab: {props.filterQuery || '(none)'}</Text>
                {props.approvals.slice(0, 30).map((entry, index) => {
                    const selected = index === props.selectedApprovalIndex;
                    const key = String(entry?.id || index);
                    return (
                        <Text key={key} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.runId || '?')}::{String(entry?.nodeId || '-')}
                        </Text>
                    );
                })}
                {props.approvals.length === 0 && <Text color={props.theme.colors.muted}>Aucune approval visible (ajuste le filtre F).</Text>}
            </Panel>

            <Panel title="Détail Approval" theme={props.theme} width={stacked ? undefined : '55%'} active={props.focusZone === 'right'}>
                <Text>id: {String(selectedApproval?.id || '-')}</Text>
                <Text>prompt: {String(selectedApproval?.prompt || '-')}</Text>
                <Text>source: {String(selectedApproval?.source || '-')}</Text>
                <Text>runId: {String(selectedApproval?.runId || '-')}</Text>
            </Panel>
        </Box>
    );
}
