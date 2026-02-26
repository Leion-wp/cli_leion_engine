import React from 'react';
import { Box, Text } from 'ink';
import { FocusZone } from '../state/types';
import { Panel } from '../ui/primitives';
import { TuiTheme } from '../ui/theme';

type HitlScreenProps = {
    theme: TuiTheme;
    focusZone: FocusZone;
    approvals: any[];
    selectedApprovalIndex: number;
};

export function HitlScreen(props: HitlScreenProps): JSX.Element {
    const selectedApproval = props.approvals[props.selectedApprovalIndex];

    return (
        <Box marginTop={1}>
            <Panel title={`HITL Inbox (${props.approvals.length})`} theme={props.theme} width="45%" marginRight={1} active={props.focusZone === 'left'}>
                <Text color={props.theme.colors.muted}>↑/↓ ou j/k | a approve | r reject</Text>
                {props.approvals.slice(0, 30).map((entry, index) => {
                    const selected = index === props.selectedApprovalIndex;
                    const key = String(entry?.id || index);
                    return (
                        <Text key={key} color={selected ? props.theme.colors.accentAlt : props.theme.colors.fg}>
                            {selected ? props.theme.symbols.pointer : ' '} {String(entry?.runId || '?')}::{String(entry?.nodeId || '-')}
                        </Text>
                    );
                })}
            </Panel>

            <Panel title="Détail Approval" theme={props.theme} width="55%" active={props.focusZone === 'right'}>
                <Text>id: {String(selectedApproval?.id || '-')}</Text>
                <Text>prompt: {String(selectedApproval?.prompt || '-')}</Text>
                <Text>source: {String(selectedApproval?.source || '-')}</Text>
                <Text>runId: {String(selectedApproval?.runId || '-')}</Text>
            </Panel>
        </Box>
    );
}
