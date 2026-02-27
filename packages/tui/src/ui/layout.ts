export type LayoutMode = 'stack' | 'compact' | 'wide';

export function computeLayoutMode(columns: number): LayoutMode {
    if (columns < 110) return 'stack';
    if (columns < 150) return 'compact';
    return 'wide';
}
