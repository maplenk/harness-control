#!/usr/bin/env node
import readline from 'node:readline';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const sessionId = arg('--session-id', 'missing-session');
const requestedModel = arg('--model', 'missing-model');
let turn = 0;
const lines = readline.createInterface({ input: process.stdin });

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  turn += 1;
  send({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    model: `resolved/${requestedModel}`,
  });
  send({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `fixture-tool-${turn}`,
          name: 'Bash',
          input: { command: `fixture-command-${turn}` },
        },
      ],
    },
  });
  send({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: `TURN_${turn}` },
    },
  });
  send({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1_784_934_000,
      rateLimitType: 'seven_day',
      utilization: 0.83,
    },
  });
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0.01 * turn,
    usage: {
      input_tokens: turn,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
    },
  });
});
