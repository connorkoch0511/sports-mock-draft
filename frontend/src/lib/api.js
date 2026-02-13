const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function req(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
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