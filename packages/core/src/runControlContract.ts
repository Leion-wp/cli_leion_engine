export const RUN_CONTROL_CONTRACT = Object.freeze({
    version: '1',
    idempotent: true,
    pauseRequestedState: 'pause_requested',
    pauseAcknowledgedState: 'paused',
    resumePendingState: 'paused',
    resumeAcknowledgedState: 'running',
    cancelRequestedState: 'cancel_requested',
    cancelTerminalState: 'cancelled',
    cancellationDominant: true,
    terminalProcessExitRequired: true
});
