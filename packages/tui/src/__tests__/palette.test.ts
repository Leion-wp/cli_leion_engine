import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPaletteItems } from '../state/palette';
import { CommandPaletteItem } from '../state/types';

const ITEMS: CommandPaletteItem[] = [
    {
        id: 'action:refresh',
        label: 'Refresh global data',
        hint: 'action',
        category: 'action',
        keywords: ['refresh', 'reload', 'sync'],
        event: { type: 'set_status', text: 'ok', tone: 'info' }
    },
    {
        id: 'tab:run',
        label: 'Aller vers run',
        hint: 'tab',
        category: 'tab',
        keywords: ['run', 'monitoring'],
        event: { type: 'switch_tab', tab: 'run' }
    },
    {
        id: 'entity:pipeline:0',
        label: 'Pipeline build_release',
        hint: 'entity',
        category: 'entity',
        keywords: ['pipeline', 'release'],
        event: { type: 'switch_tab', tab: 'pipelines' }
    }
];

test('rankPaletteItems prioritizes matching keyword', () => {
    const ranked = rankPaletteItems(ITEMS, 'refresh');
    assert.equal(ranked[0]?.id, 'action:refresh');
});

test('rankPaletteItems filters non matching entries', () => {
    const ranked = rankPaletteItems(ITEMS, 'zzz-not-found');
    assert.equal(ranked.length, 0);
});
