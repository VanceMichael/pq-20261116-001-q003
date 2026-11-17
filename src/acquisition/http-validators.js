const MAX_VALIDATOR_LENGTH = 1024;

/**
 * Response validators are untrusted input. Only keep values that can be
 * safely echoed back in a request header: no control characters, bounded
 * length, and an ETag with a quoted entity-tag (weak or strong).
 */
export function normalizeEtag(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALIDATOR_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed !== value) return null;
  return /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(trimmed) ? trimmed : null;
}

export function normalizeLastModified(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALIDATOR_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed !== value) return null;
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

export function readValidators(headers) {
  return {
    etag: normalizeEtag(headerValue(headers, "etag")),
    lastModified: normalizeLastModified(headerValue(headers, "last-modified"))
  };
}

/**
 * Build conditional request headers for a stored validator pair. A source
 * that only supplies Last-Modified still gets an If-Modified-Since request.
 */
export function buildConditionalHeaders(validators) {
  const { etag = null, lastModified = null } = validators ?? {};
  const headers = {};
  const safeEtag = normalizeEtag(etag);
  const safeLastModified = normalizeLastModified(lastModified);
  if (safeEtag) headers["if-none-match"] = safeEtag;
  if (safeLastModified) headers["if-modified-since"] = safeLastModified;
  return headers;
}

export function hasValidator(validators) {
  return Boolean(validators && (normalizeEtag(validators.etag) || normalizeLastModified(validators.lastModified)));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}
