import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { planCacheEdit } from '../src/cache-edit.js';

const app = buildApp();
const url = '/cache-edit-plan';

function cacheEdit(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('splits fully cached bytes around a deletion followed by insertion', async () => {
  const result = planCacheEdit({
    size: 20,
    cached: [{ start: 0, end: 19 }],
    edits: [{ start: 10, deleteBytes: 5, insertBytes: 3 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 18);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 15, oldEnd: 19, newStart: 13, newEnd: 17 },
  ]);
  assert.deepEqual(result.gaps, [{ start: 10, end: 12 }]);
  assert.equal(result.reusableBytes, 15);
  assert.equal(result.gapBytes, 3);
});

test('insertion alone splits the mapping and leaves one inserted byte as a gap', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [{ start: 5, deleteBytes: 0, insertBytes: 1 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 11);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 5, oldEnd: 9, newStart: 6, newEnd: 10 },
  ]);
  assert.deepEqual(result.gaps, [{ start: 5, end: 5 }]);
});

test('deletion alone splits mappings and does not merge merely adjacent new intervals', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [{ start: 5, deleteBytes: 2, insertBytes: 0 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 8);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 7, oldEnd: 9, newStart: 5, newEnd: 7 },
  ]);
  assert.deepEqual(result.gaps, []);
});

test('equal deletion and insertion leaves the replacement bytes as a gap', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [{ start: 5, deleteBytes: 2, insertBytes: 2 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 10);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 7, oldEnd: 9, newStart: 7, newEnd: 9 },
  ]);
  assert.deepEqual(result.gaps, [{ start: 5, end: 6 }]);
});

test('tail insertion preserves existing offsets and adds a tail gap', () => {
  const result = planCacheEdit({
    size: 20,
    cached: [{ start: 18, end: 19 }],
    edits: [{ start: 20, deleteBytes: 0, insertBytes: 5 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 25);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 18, oldEnd: 19, newStart: 18, newEnd: 19 },
  ]);
  assert.deepEqual(result.gaps, [
    { start: 0, end: 17 },
    { start: 20, end: 24 },
  ]);
});

test('empty resource can be created by tail insertion at offset zero', () => {
  const result = planCacheEdit({
    size: 0,
    cached: [],
    edits: [{ start: 0, deleteBytes: 0, insertBytes: 3 }],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result, {
    statusCode: 200,
    newSize: 3,
    reusableMappings: [],
    reusableBytes: 0,
    gaps: [{ start: 0, end: 2 }],
    gapBytes: 3,
  });
});

test('unordered overlapping cache intervals are deduplicated before mapping', () => {
  const result = planCacheEdit({
    size: 20,
    cached: [
      { start: 10, end: 19 },
      { start: 0, end: 12 },
      { start: 5, end: 9 },
    ],
    edits: [],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 19, newStart: 0, newEnd: 19 },
  ]);
  assert.deepEqual(result.gaps, []);
});

test('edits may be supplied out of order', () => {
  const result = planCacheEdit({
    size: 30,
    cached: [{ start: 0, end: 29 }],
    edits: [
      { start: 20, deleteBytes: 0, insertBytes: 2 },
      { start: 10, deleteBytes: 3, insertBytes: 1 },
    ],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 30);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 13, oldEnd: 19, newStart: 11, newEnd: 17 },
    { oldStart: 20, oldEnd: 29, newStart: 20, newEnd: 29 },
  ]);
  assert.deepEqual(result.gaps, [
    { start: 10, end: 10 },
    { start: 18, end: 19 },
  ]);
});

test('gaps merge old uncached bytes with inserted bytes', () => {
  const result = planCacheEdit({
    size: 20,
    cached: [
      { start: 0, end: 4 },
      { start: 15, end: 19 },
    ],
    edits: [{ start: 10, deleteBytes: 5, insertBytes: 3 }],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 15, oldEnd: 19, newStart: 13, newEnd: 17 },
  ]);
  assert.deepEqual(result.gaps, [{ start: 5, end: 12 }]);
});

test('two disjoint insertions produce two ascending gaps', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [],
    edits: [
      { start: 2, deleteBytes: 0, insertBytes: 1 },
      { start: 8, deleteBytes: 0, insertBytes: 1 },
    ],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 12);
  assert.deepEqual(result.gaps, [{ start: 0, end: 11 }]);
});

test('deleting every cached byte removes its mapping', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [{ start: 3, end: 6 }],
    edits: [{ start: 3, deleteBytes: 4, insertBytes: 2 }],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.reusableMappings, []);
  assert.deepEqual(result.gaps, [{ start: 0, end: 7 }]);
});

test('edits starting at the boundary of a previous deletion are valid', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [
      { start: 3, deleteBytes: 2, insertBytes: 1 },
      { start: 5, deleteBytes: 1, insertBytes: 1 },
    ],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.newSize, 9);
  assert.deepEqual(result.reusableMappings, [
    { oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 },
    { oldStart: 6, oldEnd: 9, newStart: 5, newEnd: 8 },
  ]);
});

test('rejects invalid array and interval object shapes', () => {
  assert.equal(
    planCacheEdit({ size: 10, cached: null, edits: [] }).statusCode,
    400,
  );
  assert.equal(
    planCacheEdit({ size: 10, cached: [], edits: null }).statusCode,
    400,
  );
  assert.equal(
    planCacheEdit({ size: 10, cached: [null], edits: [] }).statusCode,
    400,
  );
  assert.equal(
    planCacheEdit({ size: 10, cached: [], edits: [null] }).statusCode,
    400,
  );
});

test('rejects two edits with the same start', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [],
    edits: [
      { start: 3, deleteBytes: 0, insertBytes: 1 },
      { start: 3, deleteBytes: 1, insertBytes: 0 },
    ],
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'DUPLICATE_EDIT_START');
});

test('rejects an edit whose start falls inside a previous deletion range', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [],
    edits: [
      { start: 3, deleteBytes: 4, insertBytes: 1 },
      { start: 6, deleteBytes: 0, insertBytes: 1 },
    ],
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'OVERLAPPING_EDITS');
});

test('rejects a double-zero edit', () => {
  const result = planCacheEdit({
    size: 10,
    cached: [],
    edits: [{ start: 3, deleteBytes: 0, insertBytes: 0 }],
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'EMPTY_EDIT');
});

test('rejects non-empty cached intervals for size zero', () => {
  const result = planCacheEdit({
    size: 0,
    cached: [{ start: 0, end: 0 }],
    edits: [],
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'CACHED_NOT_EMPTY');
});

test('rejects invalid or out-of-bounds cache intervals', () => {
  const reversed = planCacheEdit({
    size: 10,
    cached: [{ start: 8, end: 2 }],
    edits: [],
  });
  assert.equal(reversed.statusCode, 400);
  assert.equal(reversed.code, 'INVALID_CACHED_RANGE');

  const outOfBounds = planCacheEdit({
    size: 10,
    cached: [{ start: 9, end: 10 }],
    edits: [],
  });
  assert.equal(outOfBounds.statusCode, 400);
  assert.equal(outOfBounds.code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('rejects out-of-bounds edits', () => {
  const startPastEnd = planCacheEdit({
    size: 10,
    cached: [],
    edits: [{ start: 11, deleteBytes: 0, insertBytes: 1 }],
  });
  assert.equal(startPastEnd.statusCode, 400);
  assert.equal(startPastEnd.code, 'EDIT_OUT_OF_BOUNDS');

  const deletionPastEnd = planCacheEdit({
    size: 10,
    cached: [],
    edits: [{ start: 8, deleteBytes: 3, insertBytes: 0 }],
  });
  assert.equal(deletionPastEnd.statusCode, 400);
  assert.equal(deletionPastEnd.code, 'EDIT_OUT_OF_BOUNDS');
});

test('rejects a resulting size above Number.MAX_SAFE_INTEGER', () => {
  const result = planCacheEdit({
    size: Number.MAX_SAFE_INTEGER,
    cached: [],
    edits: [{ start: Number.MAX_SAFE_INTEGER, deleteBytes: 0, insertBytes: 1 }],
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'NEW_SIZE_OUT_OF_RANGE');
});

test('strictly validates numeric types and extra fields over HTTP', async () => {
  for (const payload of [
    { size: '10', cached: [], edits: [] },
    { size: 10, cached: [{ start: '0', end: 1 }], edits: [] },
    { size: 10, cached: [], edits: [{ start: 0, deleteBytes: '0', insertBytes: 1 }] },
    { size: 10, cached: [], edits: [], extra: 1 },
  ]) {
    const res = await cacheEdit(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('limits both arrays to 1000 items', async () => {
  const cached = Array.from({ length: 1001 }, (_, index) => ({ start: index, end: index }));
  const tooManyCached = await cacheEdit({ size: 1001, cached, edits: [] });
  assert.equal(tooManyCached.statusCode, 400);

  const edits = Array.from({ length: 1001 }, (_, index) => ({
    start: index,
    deleteBytes: 0,
    insertBytes: 1,
  }));
  const tooManyEdits = await cacheEdit({ size: 1001, cached: [], edits });
  assert.equal(tooManyEdits.statusCode, 400);
});

test('HTTP route returns the cache edit plan', async () => {
  const payload = {
    size: 20,
    cached: [{ start: 0, end: 19 }],
    edits: [{ start: 10, deleteBytes: 5, insertBytes: 3 }],
  };
  const expected = {
    statusCode: 200,
    newSize: 18,
    reusableMappings: [
      { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
      { oldStart: 15, oldEnd: 19, newStart: 13, newEnd: 17 },
    ],
    reusableBytes: 15,
    gaps: [{ start: 10, end: 12 }],
    gapBytes: 3,
  };

  const res = await cacheEdit(payload);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), expected);

  const alias = await app.inject({
    method: 'POST',
    url: '/sparse-cache-edit-plan',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  assert.equal(alias.statusCode, 200);
  assert.deepEqual(alias.json(), expected);
});

test('existing endpoints remain available', async () => {
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);

  const plan = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-9', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 100 }),
  });
  assert.equal(plan.statusCode, 206);
});
