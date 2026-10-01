// Sparse cache mapping planner for resource edits.
//
// Edits use old-resource coordinates: at `start`, delete `deleteBytes`
// consecutive bytes and insert `insertBytes` new bytes. The planner maps the
// unchanged cached bytes into their new offsets. Deleted bytes are discarded,
// inserted bytes are gaps, and all interval work is closed-interval arithmetic
// rather than byte-by-byte expansion.

export const MAX_CACHED_INTERVALS = 1000;
export const MAX_EDITS = 1000;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Plan reuse of a sparse cache after a list of deletion/insertion edits.
 *
 * @returns a result object with `statusCode` 200 carrying `newSize`,
 *          `reusableMappings` and merged new-resource `gaps`, or a 400 result
 *          describing the first validation failure.
 */
export function planCacheEdit(options) {
  const { size, cached, edits } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }

  const cachedError = validateCached(cached, size);
  if (cachedError) return cachedError;
  const editsError = validateEdits(edits, size);
  if (editsError) return editsError;

  const oldSize = BigInt(size);
  const normalizedEdits = edits
    .map((edit) => ({
      start: BigInt(edit.start),
      deleteBytes: BigInt(edit.deleteBytes),
      insertBytes: BigInt(edit.insertBytes),
    }))
    .sort((a, b) => Number(a.start - b.start));

  for (let i = 1; i < normalizedEdits.length; i += 1) {
    const previous = normalizedEdits[i - 1];
    const current = normalizedEdits[i];
    if (current.start === previous.start) {
      return fail(
        'DUPLICATE_EDIT_START',
        `multiple edits start at old offset ${current.start}`,
      );
    }

    const previousDeleteEnd = previous.start + previous.deleteBytes;
    if (current.start < previousDeleteEnd) {
      return fail(
        'OVERLAPPING_EDITS',
        `edit at ${current.start} falls inside the previous deletion ending at ${previousDeleteEnd - 1n}`,
      );
    }
  }

  let newSizeBig = oldSize;
  for (const edit of normalizedEdits) {
    newSizeBig += edit.insertBytes - edit.deleteBytes;
  }
  if (newSizeBig < 0n || newSizeBig > MAX_SAFE) {
    return fail(
      'NEW_SIZE_OUT_OF_RANGE',
      `the edits produce size ${newSizeBig}, which is not a non-negative safe integer`,
    );
  }

  const mergedCache = mergeIntervals(
    cached.map((interval) => ({ start: BigInt(interval.start), end: BigInt(interval.end) })),
  );
  const regions = buildUnchangedRegions(normalizedEdits, oldSize);
  const mappings = mapCachedIntervals(mergedCache, regions);
  const gaps = gapsFromMappings(mappings, newSizeBig);

  const reusableBytes = mappings.reduce((sum, mapping) => sum + intervalLength(mapping.newStart, mapping.newEnd), 0n);
  const gapBytes = gaps.reduce((sum, gap) => sum + intervalLength(gap.start, gap.end), 0n);

  return {
    statusCode: 200,
    newSize: Number(newSizeBig),
    reusableMappings: mappings.map(toNumberMapping),
    reusableBytes: Number(reusableBytes),
    gaps: gaps.map(toNumberInterval),
    gapBytes: Number(gapBytes),
  };
}

function validateCached(cached, size) {
  if (!Array.isArray(cached)) {
    return fail('INVALID_CACHED', 'cached must be an array of {start, end} intervals');
  }
  if (cached.length > MAX_CACHED_INTERVALS) {
    return fail(
      'TOO_MANY_CACHED_INTERVALS',
      `cached carries ${cached.length} intervals; at most ${MAX_CACHED_INTERVALS} are allowed`,
    );
  }
  if (size === 0 && cached.length > 0) {
    return fail('CACHED_NOT_EMPTY', 'cached must be empty when size is 0');
  }

  for (let i = 0; i < cached.length; i += 1) {
    const interval = cached[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] must be an object with start and end`);
    }

    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].end must be a non-negative safe integer`);
    }
    if (start > end) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] has start ${start} after end ${end}`);
    }
    if (end >= size) {
      return fail(
        'CACHED_RANGE_OUT_OF_BOUNDS',
        `cached[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }
  return null;
}

function validateEdits(edits, size) {
  if (!Array.isArray(edits)) {
    return fail(
      'INVALID_EDITS',
      'edits must be an array of {start, deleteBytes, insertBytes} objects',
    );
  }
  if (edits.length > MAX_EDITS) {
    return fail(
      'TOO_MANY_EDITS',
      `edits carries ${edits.length} items; at most ${MAX_EDITS} are allowed`,
    );
  }

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      return fail(
        'INVALID_EDIT',
        `edits[${i}] must be an object with start, deleteBytes and insertBytes`,
      );
    }

    const { start, deleteBytes, insertBytes } = edit;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_EDIT_START', `edits[${i}].start must be a non-negative safe integer`);
    }
    if (start > size) {
      return fail(
        'EDIT_OUT_OF_BOUNDS',
        `edits[${i}].start ${start} lies outside the ${size}-byte resource`,
      );
    }
    if (!Number.isSafeInteger(deleteBytes) || deleteBytes < 0) {
      return fail(
        'INVALID_DELETE_BYTES',
        `edits[${i}].deleteBytes must be a non-negative safe integer`,
      );
    }
    if (deleteBytes > size - start) {
      return fail(
        'EDIT_OUT_OF_BOUNDS',
        `edits[${i}] deletes ${deleteBytes} bytes starting at ${start}, beyond the resource`,
      );
    }
    if (!Number.isSafeInteger(insertBytes) || insertBytes < 0) {
      return fail(
        'INVALID_INSERT_BYTES',
        `edits[${i}].insertBytes must be a non-negative safe integer`,
      );
    }
    if (deleteBytes === 0 && insertBytes === 0) {
      return fail('EMPTY_EDIT', `edits[${i}] neither deletes nor inserts any bytes`);
    }
  }
  return null;
}

/**
 * Build maximal old-coordinate spans of bytes that survive all edits. Each
 * region has one constant offset shift from old coordinates to new coordinates.
 */
function buildUnchangedRegions(edits, oldSize) {
  const regions = [];
  let oldCursor = 0n;
  let shift = 0n;

  for (const edit of edits) {
    if (edit.start > oldCursor) {
      regions.push({
        start: oldCursor,
        end: edit.start - 1n,
        shift,
        newStart: oldCursor + shift,
      });
    }

    oldCursor = edit.start + edit.deleteBytes;
    shift += edit.insertBytes - edit.deleteBytes;
  }

  // A tail insertion (deleteBytes === 0 and start === oldSize) leaves no
  // surviving old bytes in a final region; it only updates the gap end.
  if (oldCursor < oldSize) {
    regions.push({
      start: oldCursor,
      end: oldSize - 1n,
      shift,
      newStart: oldCursor + shift,
    });
  }

  return regions;
}

function mapCachedIntervals(cache, regions) {
  const mappings = [];
  let regionIndex = 0;

  for (const cached of cache) {
    while (regionIndex < regions.length && regions[regionIndex].end < cached.start) {
      regionIndex += 1;
    }

    for (let i = regionIndex; i < regions.length && regions[i].start <= cached.end; i += 1) {
      const region = regions[i];
      const oldStart = maxBig(cached.start, region.start);
      const oldEnd = minBig(cached.end, region.end);
      if (oldStart > oldEnd) continue;

      const mapping = {
        oldStart,
        oldEnd,
        newStart: oldStart + region.shift,
        newEnd: oldEnd + region.shift,
      };
      appendMapping(mappings, mapping);
    }
  }

  return mappings;
}

/**
 * The sweep normally separates mappings at every edit and every gap in the
 * cache. Merge only the rare boundary where both the old and new intervals are
 * exactly adjacent.
 */
function appendMapping(mappings, mapping) {
  const previous = mappings[mappings.length - 1];
  if (
    previous &&
    previous.oldEnd + 1n === mapping.oldStart &&
    previous.newEnd + 1n === mapping.newStart
  ) {
    previous.oldEnd = mapping.oldEnd;
    previous.newEnd = mapping.newEnd;
  } else {
    mappings.push({ ...mapping });
  }
}

function gapsFromMappings(mappings, newSize) {
  const gaps = [];
  let cursor = 0n;

  for (const mapping of mappings) {
    if (mapping.newStart > cursor) {
      gaps.push({ start: cursor, end: mapping.newStart - 1n });
    }
    cursor = mapping.newEnd + 1n;
  }

  if (cursor < newSize) {
    gaps.push({ start: cursor, end: newSize - 1n });
  }
  return gaps;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort(compareBigIntervals);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1n) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function intervalLength(start, end) {
  return end - start + 1n;
}

function compareBigIntervals(a, b) {
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  if (a.end < b.end) return -1;
  if (a.end > b.end) return 1;
  return 0;
}

function minBig(a, b) {
  return a < b ? a : b;
}

function maxBig(a, b) {
  return a > b ? a : b;
}

function toNumberInterval(interval) {
  return { start: Number(interval.start), end: Number(interval.end) };
}

function toNumberMapping(mapping) {
  return {
    oldStart: Number(mapping.oldStart),
    oldEnd: Number(mapping.oldEnd),
    newStart: Number(mapping.newStart),
    newEnd: Number(mapping.newEnd),
  };
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
