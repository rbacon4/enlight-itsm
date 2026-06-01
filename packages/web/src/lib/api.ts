const API_BASE = import.meta.env['VITE_API_URL'] ?? '/api';

let authToken: string | null = localStorage.getItem('enlight_token');

export function setToken(token: string) {
  authToken = token;
  localStorage.setItem('enlight_token', token);
}

export function clearToken() {
  authToken = null;
  localStorage.removeItem('enlight_token');
}

export function getToken() {
  return authToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string, init?: RequestInit) =>
    request<T>(path, { method: 'DELETE', ...init }),
};

/**
 * Triggers a browser download for an authenticated endpoint that returns a file
 * (e.g. a CSV export). Fetches the body as a Blob and saves it via a temp <a>.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }

  // Prefer the server-provided filename from Content-Disposition.
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
