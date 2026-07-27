import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  eventSequence,
  idempotencyKey,
  runId,
  specHash,
  specVersionId,
  type RunId,
} from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import type { Database } from '../persistence/index.js';
import type {
  ApplicationCommand,
  ApplicationResult,
  CommandContext,
} from '../app/commands/index.js';
import type { RoleModelSpec } from '../app/model-resolution.js';
import { buildFleetSnapshot, buildRunSnapshot } from './read-model.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENT_PAGE = 500;
const PROTOCOL_VERSION = 1;

export interface HarnessServerOptions {
  readonly db: Database;
  readonly port?: number;
  readonly token?: string;
  readonly csrfToken?: string;
  readonly staticRoot?: string;
  readonly version?: string;
  readonly execute?: (
    command: ApplicationCommand,
    context: CommandContext,
  ) => Promise<ApplicationResult>;
}

export interface HarnessServer {
  readonly server: Server;
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly csrfToken: string;
  close(): Promise<void>;
}

/** Start the MVP control server. The bind address is intentionally not configurable. */
export async function startHarnessServer(
  options: HarnessServerOptions,
): Promise<HarnessServer> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const csrfToken = options.csrfToken ?? randomBytes(24).toString('base64url');
  const server = createServer(
    createHarnessRequestHandler({ ...options, token, csrfToken }),
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('harness serve: failed to resolve the loopback listening port');
  }
  const port = address.port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    token,
    csrfToken,
    close: () => closeServer(server),
  };
}

export function createHarnessRequestHandler(
  options: HarnessServerOptions & { readonly token: string; readonly csrfToken: string },
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleRequest(options, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, 500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  };
}

async function handleRequest(
  options: HarnessServerOptions & { readonly token: string; readonly csrfToken: string },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  applySecurityHeaders(response);
  const host = request.headers.host;
  if (host === undefined || !allowedHost(host)) {
    json(response, 403, {
      ok: false,
      error: { code: 'host_refused', message: 'Host must resolve to loopback.' },
    });
    return;
  }
  const url = new URL(request.url ?? '/', `http://${host}`);
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request, options.token)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="Harness Control"');
      json(response, 401, {
        ok: false,
        error: { code: 'unauthorized', message: 'A valid scoped bearer token is required.' },
      });
      return;
    }
    if (isWriteMethod(request.method)) {
      const origin = request.headers.origin;
      if (
        origin === undefined ||
        !allowedOrigin(origin, host) ||
        request.headers['x-harness-csrf'] !== options.csrfToken
      ) {
        json(response, 403, {
          ok: false,
          error: {
            code: 'csrf_refused',
            message: 'Writes require a same-origin request and the scoped CSRF token.',
          },
        });
        return;
      }
    } else {
      const origin = request.headers.origin;
      if (origin !== undefined && !allowedOrigin(origin, host)) {
        json(response, 403, {
          ok: false,
          error: { code: 'origin_refused', message: 'Origin must be loopback and same-host.' },
        });
        return;
      }
    }
    await handleApi(options, request, response, url);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, {
      ok: false,
      error: { code: 'method_not_allowed', message: 'Only GET and HEAD serve UI assets.' },
    });
    return;
  }
  await serveStatic(options, request, response, url);
}

async function handleApi(
  options: HarnessServerOptions & { readonly token: string; readonly csrfToken: string },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/api/meta') {
    json(response, 200, {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      version: options.version ?? '0.1.0',
      features: {
        eventPolling: true,
        commands: options.execute !== undefined,
        multiRepository: false,
        assignmentModelSwitch: false,
      },
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runs') {
    json(response, 200, { ok: true, ...buildFleetSnapshot(options.db) });
    return;
  }

  const eventMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === 'GET' && eventMatch !== null) {
    const owner = runId(decodeURIComponent(eventMatch[1] as string));
    if (buildRunSnapshot(options.db, owner) === undefined) {
      notFound(response, owner);
      return;
    }
    const after = parseCursor(url.searchParams.get('after'));
    if (after === undefined) {
      json(response, 400, {
        ok: false,
        error: { code: 'invalid_cursor', message: 'after must be a non-negative integer.' },
      });
      return;
    }
    // EventRepository.fromSequence is inclusive; the public cursor is
    // exclusive, so the conversion is deliberately `after + 1`.
    const events = options.db.events
      .listByRun(owner, { fromSequence: eventSequence(after + 1) })
      .slice(0, MAX_EVENT_PAGE);
    const nextCursor =
      events.length === 0 ? after : Number(events.at(-1)?.sequence ?? after);
    json(response, 200, {
      ok: true,
      runId: String(owner),
      after,
      nextCursor,
      events: events.map((event) => ({
        sequence: Number(event.sequence),
        type: event.type,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && runMatch !== null) {
    const owner = runId(decodeURIComponent(runMatch[1] as string));
    const snapshot = buildRunSnapshot(options.db, owner);
    if (snapshot === undefined) {
      notFound(response, owner);
      return;
    }
    json(response, 200, { ok: true, run: snapshot });
    return;
  }

  if (request.method === 'POST') {
    if (options.execute === undefined) {
      json(response, 503, {
        ok: false,
        error: {
          code: 'commands_unavailable',
          message: 'This server was started without a command executor.',
        },
      });
      return;
    }
    const body = await readJsonBody(request);
    const command = commandForRoute(url.pathname, body);
    if ('error' in command) {
      json(response, command.status, { ok: false, error: command.error });
      return;
    }
    const context: CommandContext = {
      actor: 'http:local-operator',
      origin: 'http',
      idempotencyKey: idempotencyKey(
        header(request, 'idempotency-key') ?? randomBytes(18).toString('base64url'),
      ),
    };
    const result = await options.execute(command.command, context);
    json(response, httpStatus(result), applicationResponse(result));
    return;
  }

  json(response, 404, {
    ok: false,
    error: { code: 'not_found', message: `No route for ${request.method ?? 'GET'} ${url.pathname}.` },
  });
}

function commandForRoute(
  pathname: string,
  body: unknown,
):
  | { readonly command: ApplicationCommand }
  | {
      readonly status: number;
      readonly error: { readonly code: string; readonly message: string };
    } {
  const record = isRecord(body) ? body : {};
  if (pathname === '/api/runs') {
    const goal = nonEmpty(record['goal']);
    const repositories = Array.isArray(record['repositories'])
      ? record['repositories'].filter(isRecord)
      : [];
    const workspace =
      nonEmpty(record['workspacePath']) ??
      (repositories.length === 1 ? nonEmpty(repositories[0]?.['path']) : undefined);
    if (repositories.length > 1) {
      return {
        status: 422,
        error: {
          code: 'multi_repo_not_available',
          message:
            'This MVP branch currently drives one repository per run; multi-repository execution is not represented as complete.',
        },
      };
    }
    const coordinator = roleSpec(record['coordinator']);
    const implementor = roleSpec(record['implementor']);
    const verifier = roleSpec(record['verifier']);
    const executionMode =
      record['executionMode'] === 'in_place' || record['executionMode'] === 'worktree'
        ? record['executionMode']
        : undefined;
    if (
      ('implementor' in record && implementor === undefined) ||
      ('verifier' in record && verifier === undefined) ||
      ('executionMode' in record && executionMode === undefined)
    ) {
      return {
        status: 400,
        error: {
          code: 'invalid_start_defaults',
          message:
            'implementor/verifier must be {harness, model}; executionMode must be worktree or in_place.',
        },
      };
    }
    if (goal === undefined || workspace === undefined || coordinator === undefined) {
      return {
        status: 400,
        error: {
          code: 'invalid_start',
          message: 'goal, one repository path, and coordinator {harness, model} are required.',
        },
      };
    }
    return {
      command: {
        kind: 'start',
        workspace,
        goal,
        coordinator,
        ...(implementor !== undefined ? { implementor } : {}),
        ...(verifier !== undefined ? { verifier } : {}),
        ...(executionMode !== undefined ? { executionMode } : {}),
        ...(nonEmpty(record['configPath']) !== undefined
          ? { configPath: nonEmpty(record['configPath']) as string }
          : {}),
        ...(record['enableChat'] === true ? { enableChat: true as const } : {}),
      },
    };
  }

  const action = /^\/api\/runs\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (action !== null) {
    const owner = runId(decodeURIComponent(action[1] as string));
    switch (action[2]) {
      case 'approve': {
        const version = nonEmpty(record['specVersionId']);
        if (version === undefined) {
          return {
            status: 400,
            error: { code: 'invalid_approve', message: 'specVersionId is required.' },
          };
        }
        const hash = nonEmpty(record['specHash']);
        return {
          command: {
            kind: 'approve',
            runId: owner,
            specVersionId: specVersionId(version),
            ...(hash !== undefined ? { specHash: specHash(hash) } : {}),
          },
        };
      }
      case 'run':
        return {
          command: {
            kind: 'run',
            runId: owner,
            ...(roleSpec(record['implementor']) !== undefined
              ? { implementor: roleSpec(record['implementor']) as RoleModelSpec }
              : {}),
            ...(roleSpec(record['verifier']) !== undefined
              ? { verifier: roleSpec(record['verifier']) as RoleModelSpec }
              : {}),
            ...(record['executionMode'] === 'in_place' ? { inPlace: true } : {}),
          },
        };
      case 'switch-model': {
        const role = nonEmpty(record['role']);
        const target = roleSpec(record['target']);
        if (
          (role !== 'coordinator' && role !== 'implementor' && role !== 'verifier') ||
          target === undefined
        ) {
          return {
            status: 400,
            error: {
              code: 'invalid_switch_model',
              message: 'role and target {harness, model} are required.',
            },
          };
        }
        return {
          command: {
            kind: 'switchModel',
            runId: owner,
            role: role as RoleName,
            target,
          },
        };
      }
      case 'cancel':
        return { command: { kind: 'cancel', runId: owner } };
      case 'pause':
        return { command: { kind: 'pause', runId: owner } };
      case 'resume':
        return { command: { kind: 'resume', runId: owner } };
      case 'recheck':
        return { command: { kind: 'recheck', runId: owner } };
      default:
        break;
    }
  }

  if (/^\/api\/runs\/[^/]+\/assignments\/[^/]+\/(retry|reassign)$/.test(pathname)) {
    return {
      status: 501,
      error: {
        code: 'assignment_action_not_available',
        message:
          'Per-assignment retry and reassignment require the assignment-keyed scheduler/store change; this server refuses to pretend a run-wide action is assignment-scoped.',
      },
    };
  }

  return {
    status: 404,
    error: { code: 'not_found', message: `No command route for ${pathname}.` },
  };
}

async function serveStatic(
  options: HarnessServerOptions & { readonly token: string; readonly csrfToken: string },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (options.staticRoot === undefined) {
    json(response, 200, {
      ok: true,
      product: 'Harness Control',
      api: '/api/meta',
    });
    return;
  }
  const root = path.resolve(options.staticRoot);
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  let candidate = path.resolve(root, `.${requested}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    json(response, 403, {
      ok: false,
      error: { code: 'path_refused', message: 'Asset path escaped the UI root.' },
    });
    return;
  }
  let info = await stat(candidate).catch(() => undefined);
  if (info?.isDirectory() === true) {
    candidate = path.join(candidate, 'index.html');
    info = await stat(candidate).catch(() => undefined);
  }
  // SPA fallback for client-side navigation.
  if (info?.isFile() !== true) {
    candidate = path.join(root, 'index.html');
    info = await stat(candidate).catch(() => undefined);
  }
  if (info?.isFile() !== true) {
    json(response, 404, {
      ok: false,
      error: {
        code: 'ui_not_built',
        message: 'Harness Control assets are not built. Run the web build first.',
      },
    });
    return;
  }
  let bytes = await readFile(candidate);
  if (path.basename(candidate) === 'index.html') {
    const html = bytes
      .toString('utf8')
      .replaceAll('__HARNESS_TOKEN__', options.token)
      .replaceAll('__HARNESS_CSRF__', options.csrfToken);
    bytes = Buffer.from(html, 'utf8');
    response.setHeader('Cache-Control', 'no-store');
  } else {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType(candidate));
  response.setHeader('Content-Length', String(bytes.length));
  if (request.method === 'HEAD') {
    response.end();
  } else {
    response.end(bytes);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body must be valid JSON');
  }
}

function applicationResponse(result: ApplicationResult): Record<string, unknown> {
  return result.status === 'accepted'
    ? {
        ok: true,
        status: result.status,
        command: result.command,
        payload: result.payload,
      }
    : {
        ok: false,
        status: result.status,
        command: result.command,
        error: result.error,
      };
}

function httpStatus(result: ApplicationResult): number {
  switch (result.status) {
    case 'accepted':
      return 200;
    case 'invalid':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'blocked':
    case 'limit_paused':
      return 409;
    case 'rejected':
      return 422;
    case 'failed':
      return 500;
  }
}

function allowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function allowedOrigin(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === host && allowedHost(parsed.host);
  } catch {
    return false;
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) return true;
  return request.headers['x-harness-token'] === token;
}

function isWriteMethod(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function parseCursor(raw: string | null): number | undefined {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function roleSpec(raw: unknown): RoleModelSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const harness = nonEmpty(raw['harness']);
  const model = nonEmpty(raw['model']);
  if (
    (harness !== 'claude' &&
      harness !== 'codex' &&
      harness !== 'grok' &&
      harness !== 'opencode') ||
    model === undefined
  ) {
    return undefined;
  }
  const effort = nonEmpty(raw['effort']);
  return {
    harness,
    model,
    ...(effort !== undefined
      ? { effort: effort as NonNullable<RoleModelSpec['effort']> }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
}

function contentType(filename: string): string {
  switch (path.extname(filename)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function notFound(response: ServerResponse, owner: RunId): void {
  json(response, 404, {
    ok: false,
    error: { code: 'run_not_found', message: `Run ${String(owner)} was not found.` },
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(bytes.length));
  response.end(bytes);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
