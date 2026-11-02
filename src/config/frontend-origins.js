const LOCAL_FRONTEND_ORIGIN = 'http://localhost:5173';

function normalizeOrigin(value, variable) {
  const invalid = () => new Error(
    `${variable} must contain HTTP(S) origins without wildcards, credentials, paths, queries, or fragments.`
  );

  if (!/^https?:\/\//i.test(value) || /[\\,*]/.test(value)) {
    throw invalid();
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }

  if (url.href !== `${url.origin}/`) {
    throw invalid();
  }

  return url.origin;
}

function createFrontendOriginPolicy(environment = process.env) {
  const allowed = new Set([LOCAL_FRONTEND_ORIGIN]);

  for (const variable of ['FRONTEND_URL', 'ADDITIONAL_FRONTEND_ORIGINS']) {
    const configured = environment[variable];
    if (configured === undefined) continue;
    if (typeof configured !== 'string') {
      throw new Error(`${variable} must be a string containing HTTP(S) origins.`);
    }
    if (configured.trim() === '') continue;

    // FRONTEND_URL retains its existing single-origin meaning.
    const entries = variable === 'FRONTEND_URL' ? [configured] : configured.split(',');
    for (const entry of entries) allowed.add(normalizeOrigin(entry.trim(), variable));
  }

  return {
    origins: Object.freeze([...allowed]),
    // Preserve non-browser clients that do not supply an Origin header.
    isAllowedOrigin: origin => origin === undefined || allowed.has(origin),
  };
}

module.exports = { createFrontendOriginPolicy };
