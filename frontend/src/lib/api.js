const API_BASE = import.meta.env.VITE_API_BASE;

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text || "Request failed");
  return text ? JSON.parse(text) : null;
}

export async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || "Request failed");
  return text ? JSON.parse(text) : null;
}
