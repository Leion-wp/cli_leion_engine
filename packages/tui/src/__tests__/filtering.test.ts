import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryWithinView, filterWithIndex, moveWithinView } from '../services/filtering';

test('filterWithIndex keeps original indexes', () => {
    const rows = [
        { id: 'a', status: 'success' },
        { id: 'b', status: 'running' },
        { id: 'c', status: 'failure' }
    ];

    const filtered = filterWithIndex(rows, 'run', (row) => [row.id, row.status]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].index, 1);
    assert.equal(filtered[0].row.id, 'b');
});

test('moveWithinView moves inside visible indices', () => {
    const indices = [3, 7, 8, 12];
    assert.equal(moveWithinView(indices, 7, 1), 8);
    assert.equal(moveWithinView(indices, 7, -1), 3);
    assert.equal(moveWithinView(indices, 999, 1), 7);
});

test('boundaryWithinView returns first and last', () => {
    const indices = [4, 5, 9];
    assert.equal(boundaryWithinView(indices, 'first'), 4);
    assert.equal(boundaryWithinView(indices, 'last'), 9);
});
