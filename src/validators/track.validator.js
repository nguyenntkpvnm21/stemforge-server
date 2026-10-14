const trackFields = new Set([
  'title',
  'genre',
  'bpm',
  'key',
  'tags',
  'coverImageUrl',
  'description',
  'isPublic',
  'isDownloadable',
  'stems',
]);

const stemFields = new Set([
  'name',
  'audioUrl',
  'duration',
  'fileSize',
]);

function isObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

function validateCreateTrackInput(input) {
  if (!isObject(input)) {
    return 'Request body must be a Track object.';
  }

  if (Object.keys(input).some((field) => !trackFields.has(field))) {
    return 'Request contains unsupported Track fields.';
  }

  for (const field of ['title', 'genre', 'key']) {
    if (!isNonEmptyString(input[field])) {
      return field + ' must be a non-empty string.';
    }
  }

  if (!isPositiveNumber(input.bpm)) {
    return 'bpm must be a positive number.';
  }

  for (const field of ['isPublic', 'isDownloadable']) {
    if (typeof input[field] !== 'boolean') {
      return field + ' must be a boolean.';
    }
  }

  if (hasOwn(input, 'tags')) {
    if (
      !Array.isArray(input.tags) ||
      !input.tags.every(isNonEmptyString)
    ) {
      return 'tags must be an array of non-empty strings.';
    }
  }

  if (
    hasOwn(input, 'description') &&
    typeof input.description !== 'string'
  ) {
    return 'description must be a string.';
  }

  if (
    hasOwn(input, 'coverImageUrl') &&
    input.coverImageUrl !== null &&
    !isHttpsUrl(input.coverImageUrl)
  ) {
    return 'coverImageUrl must be null or a valid HTTPS URL.';
  }

  if (
    !Array.isArray(input.stems) ||
    input.stems.length < 1 ||
    input.stems.length > 4
  ) {
    return 'stems must contain 1 to 4 objects.';
  }

  for (let index = 0; index < input.stems.length; index += 1) {
    const stem = input.stems[index];
    const prefix = 'stems[' + index + ']';

    if (!isObject(stem)) {
      return prefix + ' must be an object.';
    }

    if (Object.keys(stem).some((field) => !stemFields.has(field))) {
      return prefix + ' contains unsupported fields.';
    }

    if (!isNonEmptyString(stem.name)) {
      return prefix + '.name must be a non-empty string.';
    }

    if (!isHttpsUrl(stem.audioUrl)) {
      return prefix + '.audioUrl must be a valid HTTPS URL.';
    }

    if (!isPositiveNumber(stem.duration)) {
      return prefix + '.duration must be a positive number.';
    }

    if (!Number.isSafeInteger(stem.fileSize) || stem.fileSize <= 0) {
      return prefix + '.fileSize must be a positive safe integer.';
    }
  }

  return null;
}

module.exports = { validateCreateTrackInput };