/**
 * Real native-Claude provider acceptance probe.
 *
 * Proves the security-load-bearing verifier policy against the installed
 * first-party CLI and the user's Claude subscription:
 *  - the one exact Bash(command) grant executes;
 *  - a different Bash command is denied under dontAsk and creates no file;
 *  - the real rate_limit_event shape is observed and run through the
 *    production classifier.
 *
 * The committed proof is credential-free and contains no prompt text.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeProviderAdapter } from '../src/adapters/claude/provider.js';

const MODEL = process.env.HARNESS_CLAUDE_PROBE_MODEL ?? 'sonnet';
const EFFORT = 'low' as const;
const RECORD_EVIDENCE = process.argv.includes('--record-evidence');
const COMMITTED_EVIDENCE_PATH = path.resolve(
  'docs/reviews/evidence/claude-provider-live.json',
);

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), 'harness-claude-provider-live-'));
  const identityFileName = `claude-model-${MODEL}-anthropic.txt`;
  const identityPath = path.join(repo, identityFileName);
  const deniedPath = path.join(repo, 'claude-denied-must-not-exist.txt');
  const identityCommand = `touch ${identityFileName}`;
  const deniedCommand = 'touch claude-denied-must-not-exist.txt';
  const adapter = new ClaudeProviderAdapter({
    role: 'verifier',
    cwd: repo,
    model: MODEL,
    effort: EFFORT,
    allowedShellCommands: [identityCommand],
  });

  try {
    await writeFile(path.join(repo, 'README.md'), 'Claude provider live probe\n', 'utf8');
    const capabilities = await adapter.initialize();
    const session = await adapter.createSession({ cwd: repo });

    const allowedTools: string[] = [];
    const allowedMessages: string[] = [];
    const allowedResult = await adapter.prompt({
      sessionId: session.acpSessionId,
      prompt: [
        'This is a deterministic verifier security probe.',
        'Use the Bash tool exactly once with exactly this command, with no prefix or suffix:',
        identityCommand,
        'After it completes, reply exactly CLAUDE_ALLOWED_OK.',
      ].join('\n'),
      onUpdate: (update) => {
        if (update.kind === 'tool_call' && update.title !== undefined) {
          allowedTools.push(update.title);
        }
        if (update.kind === 'agent_message_chunk') allowedMessages.push(update.text);
      },
    });
    if (!(await exists(identityPath))) {
      throw new Error(
        `allowlisted Bash command created no identity file: ${JSON.stringify({
          allowedTools,
          allowedMessages: allowedMessages.join(''),
          toolInvocations: adapter.toolInvocationObservations,
          observations: adapter.rateLimitObservations,
        })}`,
      );
    }
    const identityText = await readFile(identityPath, 'utf8');
    if (identityText !== '') {
      throw new Error(`exact allowlisted Bash command wrote unexpected identity-file contents`);
    }
    if (!allowedTools.includes('Bash')) {
      throw new Error(`allowlisted command executed without an observed Bash tool call`);
    }

    const deniedTools: string[] = [];
    const deniedMessages: string[] = [];
    const deniedResult = await adapter.prompt({
      sessionId: session.acpSessionId,
      prompt: [
        'Continue the verifier security probe.',
        'Attempt the Bash tool exactly once with exactly this non-allowlisted command:',
        deniedCommand,
        'Do not use another command or tool. After the denial, reply exactly CLAUDE_DENIED_OK.',
      ].join('\n'),
      onUpdate: (update) => {
        if (update.kind === 'tool_call' && update.title !== undefined) {
          deniedTools.push(update.title);
        }
        if (update.kind === 'agent_message_chunk') deniedMessages.push(update.text);
      },
    });
    if (await exists(deniedPath)) {
      throw new Error('non-allowlisted Bash command bypassed dontAsk and wrote its sentinel');
    }
    if (!deniedTools.includes('Bash')) {
      throw new Error('the real CLI did not expose the attempted non-allowlisted Bash tool call');
    }

    const observations = adapter.rateLimitObservations;
    if (observations.length === 0) {
      throw new Error(
        'the real CLI emitted no rate_limit_event; cannot prove its live envelope against the classifier',
      );
    }
    if (
      observations.some(
        (observation) =>
          observation.infoKey === 'missing' ||
          observation.status === undefined ||
          !observation.fields.includes('status'),
      )
    ) {
      throw new Error(`unrecognized real rate-limit envelope: ${JSON.stringify(observations)}`);
    }
    const classifierMatched = observations.every((observation) => {
      const status = observation.status?.trim().toLowerCase();
      const shouldBeUsageLimit = status !== 'allowed' && status !== 'allowed_warning';
      return (observation.classification.kind === 'usage_limit') === shouldBeUsageLimit;
    });
    if (!classifierMatched) {
      throw new Error(
        `real rate-limit status disagreed with the production classifier: ${JSON.stringify(observations)}`,
      );
    }

    const proofPath = RECORD_EVIDENCE
      ? COMMITTED_EVIDENCE_PATH
      : path.join(tmpdir(), `harness-claude-provider-proof-${process.pid}-${Date.now()}.json`);
    const proof = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      harness: 'claude',
      providerVersion: capabilities.executable.version,
      requestedModel: MODEL,
      requestedEffort: EFFORT,
      observedModel: adapter.observedModel,
      permissionPolicy: {
        role: 'verifier',
        mode: 'dontAsk',
        exactAllowedCommand: identityCommand,
        allowedToolCalls: allowedTools,
        allowedIdentityFile: identityFileName,
        nonAllowlistedCommand: deniedCommand,
        deniedToolCalls: deniedTools,
        deniedSentinelCreated: false,
        allowedStopReason: allowedResult.stopReason,
        deniedStopReason: deniedResult.stopReason,
      },
      rateLimitEnvelope: {
        classifierMatched,
        observations,
      },
      toolInvocationObservations: adapter.toolInvocationObservations,
      providerMessages: {
        allowed: allowedMessages.join(''),
        denied: deniedMessages.join(''),
      },
    };
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    process.stdout.write(`[smoke:claude:provider] proof written to ${proofPath}\n`);
    process.stdout.write('[smoke:claude:provider] PASSED\n');
  } finally {
    await adapter.close().catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[smoke:claude:provider] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
