const zlib = require("zlib");

const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

// Below this, gzip's overhead outweighs the saving.
const MIN_COMPRESS_BYTES = 1024;

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
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
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept-encoding") {
      return String(headers[key] || "").toLowerCase().includes("gzip");
    }
  }
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
