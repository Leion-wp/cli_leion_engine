import { CommandPaletteItem } from './types';

function normalize(value: string): string {
    return value.toLowerCase().trim();
}

function tokenScore(haystack: string, token: string): number {
    if (!token) return 0;
    const index = haystack.indexOf(token);
    if (index < 0) return -10_000;
    const prefixBonus = index === 0 ? 30 : 0;
    const tightnessBonus = Math.max(0, 20 - index);
    return 50 + prefixBonus + tightnessBonus - token.length;
}

function fuzzyScore(item: CommandPaletteItem, query: string): number {
    const base = `${item.label} ${item.hint} ${item.keywords.join(' ')}`;
    const haystack = normalize(base);
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 1;
    let score = 0;
    for (const token of tokens) {
        const tokenValue = tokenScore(haystack, token);
        if (tokenValue < 0) return -10_000;
        score += tokenValue;
    }
    if (item.category === 'action') score += 5;
    if (item.category === 'tab') score += 2;
    return score;
}

export function rankPaletteItems(items: CommandPaletteItem[], query: string, limit = 20): CommandPaletteItem[] {
    const scored = items
        .map((item) => ({ item, score: fuzzyScore(item, query) }))
        .filter((entry) => entry.score > -1000)
        .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
        .slice(0, Math.max(1, limit))
        .map((entry) => entry.item);
    return scored;
}
