export type IndexedRow<T> = {
    row: T;
    index: number;
};

function normalize(value: string): string {
    return value.trim().toLowerCase();
}

export function normalizeFilterQuery(query: string): string {
    return normalize(query);
}

export function buildSearchText(values: unknown[]): string {
    return values
        .map((value) => {
            if (value === undefined || value === null) return '';
            if (typeof value === 'string') return value;
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        })
        .join(' ')
        .toLowerCase();
}

export function filterWithIndex<T>(rows: T[], query: string, toSearchFields: (row: T) => unknown[]): Array<IndexedRow<T>> {
    const normalized = normalizeFilterQuery(query);
    const indexed = rows.map((row, index) => ({ row, index }));
    if (!normalized) return indexed;

    return indexed.filter((entry) => {
        const text = buildSearchText(toSearchFields(entry.row));
        return text.includes(normalized);
    });
}

export function moveWithinView(viewIndices: number[], currentRawIndex: number, delta: number): number | undefined {
    if (viewIndices.length === 0) return undefined;
    const currentVisible = viewIndices.indexOf(currentRawIndex);
    const base = currentVisible >= 0 ? currentVisible : 0;
    const nextVisible = Math.max(0, Math.min(viewIndices.length - 1, base + delta));
    return viewIndices[nextVisible];
}

export function boundaryWithinView(viewIndices: number[], edge: 'first' | 'last'): number | undefined {
    if (viewIndices.length === 0) return undefined;
    return edge === 'first' ? viewIndices[0] : viewIndices[viewIndices.length - 1];
}
