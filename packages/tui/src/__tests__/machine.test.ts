import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialUiState, uiReducer } from '../state/machines';

test('uiReducer opens and closes palette', () => {
    const initial = createInitialUiState();
    const opened = uiReducer(initial, { type: 'open_palette' });
    assert.equal(opened.palette.open, true);
    assert.equal(opened.focusZone, 'palette');

    const closed = uiReducer(opened, { type: 'close_palette' });
    assert.equal(closed.palette.open, false);
    assert.notEqual(closed.focusZone, 'palette');
});

test('uiReducer clamps selection index', () => {
    const initial = createInitialUiState();
    const moved = uiReducer(initial, { type: 'select_index', key: 'pipeline', index: 99, max: 3 });
    assert.equal(moved.selectedPipelineIndex, 2);
});
