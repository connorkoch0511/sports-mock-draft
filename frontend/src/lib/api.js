import { getCurrentIdToken } from "./idToken.js";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
if (!API_BASE) {
  throw new Error("Missing VITE_API_BASE_URL (check .env.production / .env.local)");
}

async function req(path, options = {}) {
  // Attached only when there is one. An absent token means an absent header,
  // never an empty or "Bearer null" one -- today every endpoint is
  // unauthenticated, and a malformed header would be a change in what they
  // receive rather than the no-op this is meant to be.
  const token = getCurrentIdToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

export const apiGet = (path) => req(path);
export const apiPost = (path, body) => req(path, { method: "POST", body: JSON.stringify(body || {}) });
export const apiPut = (path, body) => req(path, { method: "PUT", body: JSON.stringify(body || {}) });
export const apiDelete = (path) => req(path, { method: "DELETE" });