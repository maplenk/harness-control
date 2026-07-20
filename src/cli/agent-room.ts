/**
 * Agent Room adapter for opt-in coordinator planning chat.
 *
 * Agent Room is an external local skill, not a package dependency. We launch
 * its dependency-free CLI only when `--enable-chat` is requested, force its
 * listener to 127.0.0.1, then use its documented localhost JSON API for the
 * foreground discussion loop. The default planning path never probes or
 * starts Agent Room.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  PlanningChatFactory,
  PlanningChatMessage,
  PlanningChatParticipant,
  PlanningChatRoom,
  PlanningChatUpdate,
} from '../app/planning-chat.js';

const DEFAULT_AGENT_ROOM_PORT = 7331;
const AGENT_ROOM_CODE = /\b(AM-[A-HJ-NP-Z2-9]{4})\b/;

export class AgentRoomUnavailableError extends Error {
  override readonly name: string = 'AgentRoomUnavailableError';
}

interface AgentRoomMessageJson {
  readonly id?: unknown;
  readonly sender?: unknown;
  readonly content?: unknown;
  readonly kind?: unknown;
  readonly created_at?: unknown;
  readonly addressed_to_you?: unknown;
}

interface AgentRoomPollJson {
  readonly status?: unknown;
  readonly active_agents?: unknown;
  readonly addressed_only?: unknown;
  readonly should_respond?: unknown;
  readonly participants?: unknown;
  readonly messages?: unknown;
}

export interface AgentRoomReady {
  readonly code: string;
  readonly invitation: string;
  readonly viewerUrl: string;
}

export interface AgentRoomCommandInput {
  readonly cliPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface AgentRoomAdapterOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cliPath?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  readonly runCli?: (input: AgentRoomCommandInput) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  /** Called synchronously after room creation so the CLI can print the invitation while planning remains active. */
  readonly onReady?: (room: AgentRoomReady) => void;
}

function defaultCliPath(env: NodeJS.ProcessEnv): string {
  const configured = env['AGENT_ROOM_CLI'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  const codexHome =
    env['CODEX_HOME'] !== undefined && env['CODEX_HOME']?.trim() !== ''
      ? (env['CODEX_HOME'] as string)
      : path.join(homedir(), '.codex');
  return path.join(codexHome, 'skills', 'agent-room', 'scripts', 'agent_room.mjs');
}

function runAgentRoomCli(input: AgentRoomCommandInput): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [input.cliPath, ...input.args],
      { env: input.env, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new AgentRoomUnavailableError(
              `Agent Room command failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AgentRoomUnavailableError(
      `Agent Room returned a non-JSON response (${response.status} ${response.statusText})`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRoomUnavailableError('Agent Room returned an invalid JSON object');
  }
  const object = value as Record<string, unknown>;
  if (!response.ok) {
    throw new AgentRoomUnavailableError(
      typeof object['error'] === 'string'
        ? object['error']
        : `Agent Room request failed (${response.status} ${response.statusText})`,
    );
  }
  return object;
}

function asMessage(raw: AgentRoomMessageJson): PlanningChatMessage {
  const kind =
    raw.kind === 'human' || raw.kind === 'system' || raw.kind === 'summary'
      ? raw.kind
      : 'agent';
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    sender: typeof raw.sender === 'string' ? raw.sender : 'Room',
    content: typeof raw.content === 'string' ? raw.content : '',
    kind,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    addressedToCoordinator: raw.addressed_to_you === true,
  };
}

function asPoll(raw: AgentRoomPollJson): PlanningChatUpdate {
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter((message): message is AgentRoomMessageJson => typeof message === 'object' && message !== null)
        .map(asMessage)
    : [];
  const participants: PlanningChatParticipant[] = Array.isArray(raw.participants)
    ? raw.participants.flatMap((participant) => {
        if (typeof participant !== 'object' || participant === null) return [];
        const record = participant as Record<string, unknown>;
        if (typeof record['name'] !== 'string') return [];
        return [
          {
            name: record['name'],
            role: record['role'] === 'human' ? 'human' : 'agent',
          },
        ];
      })
    : [];
  return {
    status: raw.status === 'closed' ? 'closed' : 'open',
    activeAgents: typeof raw.active_agents === 'number' ? raw.active_agents : 0,
    addressedOnly: raw.addressed_only === true,
    shouldRespond: raw.should_respond === true,
    participants,
    messages,
  };
}

/**
 * Build the production planning-chat factory. No filesystem/network/process
 * work happens until `create` is called by a chat-enabled coordinator.
 */
export function createAgentRoomPlanningChatFactory(
  options: AgentRoomAdapterOptions = {},
): PlanningChatFactory {
  const env = options.env ?? process.env;
  const cliPath = options.cliPath ?? defaultCliPath(env);
  const port = options.port ?? Number(env['AGENT_ROOM_PORT'] ?? DEFAULT_AGENT_ROOM_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runCli = options.runCli ?? runAgentRoomCli;
  const roomEnv: NodeJS.ProcessEnv = {
    ...env,
    AGENT_ROOM_HOST: '127.0.0.1',
    AGENT_ROOM_PORT: String(port),
  };

  return {
    async create({ runId, goal, coordinatorName }): Promise<PlanningChatRoom> {
      if (options.runCli === undefined) {
        try {
          await access(cliPath);
        } catch {
          throw new AgentRoomUnavailableError(
            `Planning chat was enabled, but Agent Room is not installed at ${cliPath}. ` +
              'Install https://github.com/steviebuilds/agent-room or set AGENT_ROOM_CLI to its scripts/agent_room.mjs path.',
          );
        }
      }

      const created = await runCli({
        cliPath,
        args: [
          'create',
          '--title',
          `Planning ${runId}`,
          '--objective',
          `Discuss the task plan, challenge assumptions, and produce a testable specification for: ${goal}`,
          '--name',
          coordinatorName,
        ],
        env: roomEnv,
      });
      const code = created.stdout.match(AGENT_ROOM_CODE)?.[1];
      if (code === undefined) {
        throw new AgentRoomUnavailableError(
          `Agent Room did not return a room code. Output: ${created.stdout.trim() || '(empty)'}`,
        );
      }
      const invitation = created.stdout.trim();
      const viewerUrl = `${baseUrl}/rooms/${code}`;
      options.onReady?.({ code, invitation, viewerUrl });

      const api = async (
        method: 'GET' | 'POST',
        endpoint: string,
        body?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        const response = await fetchImpl(`${baseUrl}${endpoint}`, {
          method,
          ...(body !== undefined
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }
            : {}),
        });
        return readJson(response);
      };

      return {
        code,
        invitation,
        viewerUrl,
        coordinatorName,
        async send(content): Promise<void> {
          await api('POST', `/api/rooms/${code}/messages`, {
            name: coordinatorName,
            content,
          });
        },
        async listen(waitSeconds): Promise<PlanningChatUpdate> {
          const seconds = Math.min(300, Math.max(0, Math.floor(waitSeconds)));
          const result = (await api(
            'GET',
            `/api/rooms/${code}/messages?name=${encodeURIComponent(coordinatorName)}&wait=${seconds}`,
          )) as AgentRoomPollJson;
          return asPoll(result);
        },
        async close(summary): Promise<void> {
          await api('POST', `/api/rooms/${code}/close`, {
            name: coordinatorName,
            summary,
          });
        },
      };
    },
  };
}
