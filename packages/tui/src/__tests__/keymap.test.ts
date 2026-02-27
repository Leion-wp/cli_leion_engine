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

test('resolveGlobalKeyAction maps shift arrows to relative tab switch', () => {
    const left = resolveGlobalKeyAction('', { shift: true, leftArrow: true }, 'hybrid', true);
    const right = resolveGlobalKeyAction('', { shift: true, rightArrow: true }, 'hybrid', true);

    assert.equal(left.type, 'switch_tab_relative');
    assert.equal(right.type, 'switch_tab_relative');
    if (left.type === 'switch_tab_relative') {
        assert.equal(left.delta, -1);
    }
    if (right.type === 'switch_tab_relative') {
        assert.equal(right.delta, 1);
    }
});

test('resolveGlobalKeyAction maps plain left/right arrows to relative tab switch fallback', () => {
    const left = resolveGlobalKeyAction('', { leftArrow: true }, 'hybrid', true);
    const right = resolveGlobalKeyAction('', { rightArrow: true }, 'hybrid', true);

    assert.equal(left.type, 'switch_tab_relative');
    assert.equal(right.type, 'switch_tab_relative');
    if (left.type === 'switch_tab_relative') {
        assert.equal(left.delta, -1);
    }
    if (right.type === 'switch_tab_relative') {
        assert.equal(right.delta, 1);
    }
});
