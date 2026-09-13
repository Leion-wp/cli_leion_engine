export const RUN_LOG_CURSOR_FORMAT = 'lr1';
export const RUN_LOG_EVENT_VERSION = 1;
export const RUN_LOG_DEFAULT_LIMIT = 100;
export const RUN_LOG_MAX_LIMIT = 200;
export const RUN_LOG_MAX_RECORD_BYTES = 16 * 1024;
export const RUN_LOG_MAX_RESPONSE_BYTES = 512 * 1024;
export const RUN_LOG_MAX_SCAN_BYTES = 8 * 1024 * 1024;

export const RUN_LOG_CONTRACT = Object.freeze({
    version: '1',
    cursorFormat: RUN_LOG_CURSOR_FORMAT,
    cursorMonotone: true,
    legacyIntegerCursor: true,
    eventVersion: RUN_LOG_EVENT_VERSION,
    stableEventIds: true,
    corruptionPolicy: 'projected_event',
    canonicalFields: [
        'run_id',
        'detached_run_id',
        'correlation_id',
        'events',
        'next_cursor',
        'has_more'
    ],
    limits: {
        default: RUN_LOG_DEFAULT_LIMIT,
        max: RUN_LOG_MAX_LIMIT,
        maxRecordBytes: RUN_LOG_MAX_RECORD_BYTES,
        maxResponseBytes: RUN_LOG_MAX_RESPONSE_BYTES,
        maxScanBytes: RUN_LOG_MAX_SCAN_BYTES
    }
});
