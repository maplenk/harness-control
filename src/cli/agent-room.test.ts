import { describe, expect, it } from 'vitest';
import { runId } from '../domain/ids.js';
import {
  AgentRoomUnavailableError,
  createAgentRoomPlanningChatFactory,
  type AgentRoomCommandInput,
} from './agent-room.js';

describe('Agent Room planning-chat adapter', () => {
  it('creates a localhost room, maps unread messages, sends, and closes', async () => {
    let command: AgentRoomCommandInput | undefined;
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    let ready: { readonly code: string; readonly invitation: string; readonly viewerUrl: string } | undefined;

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({
            room: 'AM-ABCD',
            status: 'open',
            active_agents: 2,
            addressed_only: true,
            should_respond: true,
            participants: [
              { name: 'Coordinator', role: 'agent' },
              { name: 'Sol', role: 'agent' },
            ],
            messages: [
              {
                id: 7,
                sender: 'Sol',
                content: '@Coordinator challenge the rollback plan.',
                kind: 'agent',
                created_at: '2026-07-20T00:00:00Z',
                addressed_to_you: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, message: { id: 8 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const factory = createAgentRoomPlanningChatFactory({
      cliPath: '/fake/agent_room.mjs',
      port: 7444,
      fetchImpl,
      runCli: async (input) => {
        command = input;
        return {
          stdout:
            'Paste this to your other agents:\n\nUse the agent-room skill to join room: http://127.0.0.1:7444/rooms/AM-ABCD\n',
          stderr: '',
        };
      },
      onReady: (room) => {
        ready = room;
      },
    });

    const room = await factory.create({
      runId: runId('run_1'),
      goal: 'Design a safer retry path',
      coordinatorName: 'Coordinator',
    });
    await room.send('Opening position');
    const update = await room.listen(45);
    await room.close('Validated spec produced.');

    expect(command?.env['AGENT_ROOM_HOST']).toBe('127.0.0.1');
    expect(command?.env['AGENT_ROOM_PORT']).toBe('7444');
    expect(command?.args.some((arg) => arg.includes('Design a safer retry path'))).toBe(true);
    expect(ready).toEqual({
      code: 'AM-ABCD',
      invitation:
        'Paste this to your other agents:\n\nUse the agent-room skill to join room: http://127.0.0.1:7444/rooms/AM-ABCD',
      viewerUrl: 'http://127.0.0.1:7444/rooms/AM-ABCD',
    });
    expect(update).toMatchObject({
      status: 'open',
      activeAgents: 2,
      addressedOnly: true,
      shouldRespond: true,
      participants: [
        { name: 'Coordinator', role: 'agent' },
        { name: 'Sol', role: 'agent' },
      ],
      messages: [
        {
          id: 7,
          sender: 'Sol',
          kind: 'agent',
          addressedToCoordinator: true,
        },
      ],
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:7444/api/rooms/AM-ABCD/messages',
      'http://127.0.0.1:7444/api/rooms/AM-ABCD/messages?name=Coordinator&wait=45',
      'http://127.0.0.1:7444/api/rooms/AM-ABCD/close',
    ]);
  });

  it('fails lazily with an install hint when chat is enabled without Agent Room', async () => {
    const factory = createAgentRoomPlanningChatFactory({
      cliPath: '/path/that/does/not/exist/agent_room.mjs',
    });

    await expect(
      factory.create({
        runId: runId('run_missing_room'),
        goal: 'g',
        coordinatorName: 'Coordinator',
      }),
    ).rejects.toMatchObject({
      name: AgentRoomUnavailableError.name,
      message: expect.stringContaining('AGENT_ROOM_CLI'),
    });
  });
});
