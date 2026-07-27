import type {
  EventWire,
  FleetRunWire,
  MetaWire,
  RunWire,
} from './types';

function metaContent(name: string): string | undefined {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  if (value === undefined || value === '' || value.startsWith('__HARNESS_')) return undefined;
  return value;
}

export function hasLiveConnection(): boolean {
  return metaContent('harness-token') !== undefined;
}

async function request<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const token = metaContent('harness-token');
  if (token === undefined) throw new Error('Harness Control is not connected to a local daemon.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.method !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
    const csrf = metaContent('harness-csrf');
    if (csrf === undefined) throw new Error('The scoped CSRF token is missing.');
    headers.set('X-Harness-CSRF', csrf);
    headers.set('Idempotency-Key', crypto.randomUUID());
  }
  const response = await fetch(pathname, { ...init, headers });
  const body = (await response.json()) as {
    readonly ok?: boolean;
    readonly error?: { readonly message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Harness Control request failed (${response.status}).`);
  }
  return body as T;
}

export async function fetchMeta(): Promise<MetaWire> {
  return request<MetaWire & { readonly ok: true }>('/api/meta');
}

export async function fetchFleet(): Promise<readonly FleetRunWire[]> {
  const body = await request<{ readonly ok: true; readonly runs: readonly FleetRunWire[] }>(
    '/api/runs',
  );
  return body.runs;
}

export async function fetchRun(runId: string): Promise<RunWire> {
  const body = await request<{ readonly ok: true; readonly run: RunWire }>(
    `/api/runs/${encodeURIComponent(runId)}`,
  );
  return body.run;
}

export async function fetchEvents(
  runId: string,
  after: number,
): Promise<{ readonly events: readonly EventWire[]; readonly nextCursor: number }> {
  return request(
    `/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
  );
}

export async function postCommand(
  pathname: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  return request(pathname, { method: 'POST', body: JSON.stringify(body) });
}
