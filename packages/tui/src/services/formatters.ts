import { StatusTone } from '../state/types';

export function formatTime(value: unknown): string {
    const ts = Number(value || Date.now());
    if (!Number.isFinite(ts)) return '--:--:--';
    return new Date(ts).toLocaleTimeString();
}

export function statusTone(input: string): StatusTone {
    const normalized = String(input || '').trim().toLowerCase();
    if (normalized === 'success' || normalized === 'running') return 'ok';
    if (normalized.includes('pause') || normalized === 'starting') return 'warn';
    if (normalized === 'failure' || normalized === 'cancelled' || normalized === 'cancel_requested') return 'err';
    return 'info';
}

export function boundedAppend(lines: string[], next: string[], maxItems: number): string[] {
    const merged = [...lines, ...next];
    if (merged.length <= maxItems) return merged;
    return merged.slice(merged.length - maxItems);
}

export function tailWindow(lines: string[], windowSize: number, offsetFromEnd: number): string[] {
    const safeOffset = Math.max(0, offsetFromEnd);
    const end = Math.max(0, lines.length - safeOffset);
    const start = Math.max(0, end - Math.max(1, windowSize));
    return lines.slice(start, end);
}

export function formatEventLine(event: any): string {
    const ts = formatTime(event?.ts);
    const type = String(event?.type || 'unknown');
    const payload = event?.payload || {};
    if (type === 'stepLog') {
        return `[${ts}] ${type}: ${String(payload?.text || '').trim()}`;
    }
    if (type === 'stepStart' || type === 'stepEnd') {
        return `[${ts}] ${type} ${String(payload?.stepId || payload?.intentId || '')}`.trim();
    }
    return `[${ts}] ${type}`;
}

export function tryExtractLogLine(event: any): string | undefined {
    if (String(event?.type || '') !== 'stepLog') return undefined;
    const payload = event?.payload || {};
    const text = String(payload?.text || '').trim();
    if (!text) return undefined;
    return `[${formatTime(event?.ts)}] ${text}`;
}
