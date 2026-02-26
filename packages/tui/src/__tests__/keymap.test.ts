import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGlobalKeyAction } from '../state/keymap';

test('resolveGlobalKeyAction maps ctrl+k to palette', () => {
    const action = resolveGlobalKeyAction('k', { ctrl: true }, 'hybrid', true);
    assert.equal(action.type, 'open_palette');
});

test('resolveGlobalKeyAction maps hybrid j/k movement', () => {
    const up = resolveGlobalKeyAction('k', {}, 'hybrid', true);
    const down = resolveGlobalKeyAction('j', {}, 'hybrid', true);
    assert.equal(up.type, 'move_up');
    assert.equal(down.type, 'move_down');
});

test('resolveGlobalKeyAction maps tab switch shortcuts', () => {
    const action = resolveGlobalKeyAction('3', {}, 'classic', true);
    assert.equal(action.type, 'switch_tab');
    if (action.type === 'switch_tab') {
        assert.equal(action.tab, 'editor');
    }
});
