const KEY_STORAGE = 'claude-monitor-key';

export const getKey = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
};

export const setKey = (key) => {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // storage unavailable; key lives only for this page load
  }
};

export class UnauthorizedError extends Error {}

export async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const key = getKey();
  const res = await fetch(`/api${path}${qs.size ? `?${qs}` : ''}`, {
    headers: key ? { 'x-api-key': key } : {},
  });
  if (res.status === 401) throw new UnauthorizedError('API key required');
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}
