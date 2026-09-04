const zlib = require("zlib");

const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

// Below this, gzip's overhead outweighs the saving.
const MIN_COMPRESS_BYTES = 1024;

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

/**
 * Does this request say it can decode gzip?
 *
 * API Gateway's payload format 2.0 lower-cases header names, but this scans
 * case-insensitively anyway: relying on that silently is how compression
 * becomes a no-op nobody notices.
 */
function acceptsGzip(event) {
  const headers = event && event.headers;
  if (!headers || typeof headers !== "object") return false;

  let value = null;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept-encoding") {
      value = String(headers[key] || "");
      break;
    }
  }
  if (!value) return false;

  // RFC 9110 §12.5.3: a comma-separated list of codings, each optionally
  // carrying a ";q=" weight. q=0 means "not acceptable" -- a refusal, not
  // consent, which a substring match for "gzip" reads backwards. An absent
  // q means 1.0.
  //
  // `*` matches "any available content coding not explicitly listed" -- so
  // an explicit `gzip` entry always decides over a `*` entry, regardless of
  // which one appears first in the header. Resolve a single q-value for
  // each of "gzip" and "*" across the whole header (last occurrence wins,
  // which is deterministic and the conventional reading of a repeated
  // coding), then let the explicit gzip value decide if present, falling
  // back to the wildcard only when gzip was never explicitly listed.
  let gzipQ = null;
  let starQ = null;

  for (const part of value.split(",")) {
    const [rawCoding, ...params] = part.split(";");
    const coding = rawCoding.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;

    const qParam = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));

    let q = 1;
    if (qParam) {
      const parsed = Number(qParam.slice(2));
      // A malformed weight fails closed: sending plain JSON is always safe,
      // sending gzip to a client that cannot decode it is not.
      q = Number.isFinite(parsed) ? parsed : 0;
    }

    if (coding === "gzip") gzipQ = q;
    else starQ = q;
  }

  if (gzipQ !== null) return gzipQ > 0;
  if (starQ !== null) return starQ > 0;
  return false;
}

/**
 * A `json(statusCode, body)` bound to one request, which gzips the body when
 * the client accepts it and the payload is worth compressing.
 *
 * API Gateway base64-decodes the body when `isBase64Encoded` is true, and the
 * browser decompresses on the strength of the Content-Encoding header, so
 * callers and clients see no difference beyond the wire size.
 *
 * A client that did not ask for gzip receives byte-for-byte what it always did.
 */
function responder(event) {
  const gzipOk = acceptsGzip(event);

  return function json(statusCode, body) {
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Vary": "Accept-Encoding",
      ...corsHeaders(),
    };

    if (!gzipOk || Buffer.byteLength(payload) < MIN_COMPRESS_BYTES) {
      return { statusCode, headers, body: payload };
    }

    return {
      statusCode,
      headers: { ...headers, "Content-Encoding": "gzip" },
      body: zlib.gzipSync(payload).toString("base64"),
      isBase64Encoded: true,
    };
  };
}

module.exports = {
  ALLOWED_METHODS,
  MIN_COMPRESS_BYTES,
  corsHeaders,
  json,
  responder,
};
