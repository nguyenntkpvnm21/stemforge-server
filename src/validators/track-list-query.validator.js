const allowedParameters = new Set(['page', 'limit', 'q', 'genre', 'key', 'bpmMin', 'bpmMax', 'tag', 'sort']);
const textFields = { q: 'title', genre: 'genre', key: 'key', tag: 'tags' };
const sortOrders = {
  newest: { createdAt: -1, _id: -1 },
  mostLiked: { likesCount: -1, createdAt: -1, _id: -1 },
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTrackListFilters(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
    Object.keys(query).some(name => !allowedParameters.has(name))) {
    return { error: 'Query contains unsupported Track list parameters.' };
  }

  const sortName = query.sort === undefined ? 'newest' : query.sort;
  if (typeof sortName !== 'string' || !Object.hasOwn(sortOrders, sortName)) {
    return { error: 'sort must be newest or mostLiked.' };
  }

  // Construct every MongoDB field/operator here; never forward query objects.
  const filter = { isPublic: true };
  for (const [parameter, field] of Object.entries(textFields)) {
    const value = query[parameter];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 100 || value.trim().length === 0) {
      return { error: parameter + ' must be a non-empty string of at most 100 characters.' };
    }
    if (value.includes('\u0000')) {
      return { error: parameter + ' must not contain U+0000 (NUL).' };
    }
    const literal = escapeRegex(value.trim());
    filter[field] = { $regex: parameter === 'q' ? literal : '^' + literal + '$', $options: 'i' };
  }

  const bounds = {};
  for (const parameter of ['bpmMin', 'bpmMax']) {
    const value = query[parameter];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value) ||
      !Number.isFinite(Number(value)) || Number(value) <= 0) {
      return { error: parameter + ' must be a positive decimal number of at most 32 characters.' };
    }
    bounds[parameter] = Number(value);
  }
  if (bounds.bpmMin !== undefined && bounds.bpmMax !== undefined && bounds.bpmMin > bounds.bpmMax) {
    return { error: 'bpmMin must be less than or equal to bpmMax.' };
  }
  if (bounds.bpmMin !== undefined || bounds.bpmMax !== undefined) {
    filter.bpm = {};
    if (bounds.bpmMin !== undefined) filter.bpm.$gte = bounds.bpmMin;
    if (bounds.bpmMax !== undefined) filter.bpm.$lte = bounds.bpmMax;
  }
  return { filter, sort: { ...sortOrders[sortName] } };
}

module.exports = { parseTrackListFilters };
