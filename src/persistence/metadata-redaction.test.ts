/**
 * W3-3 metadata-sink redaction — the persistence-boundary half (§17.1;
 * §19 test 15's "redaction across sinks" extended to the DB metadata sinks).
 *
 * The external review planted an `API_KEY=...` secret in user-origin free
 * text and read it back verbatim out of event/projection rows. These tests
 * pin the fix at its two choke points: registered free-text fields (and ONLY
 * those) are redacted inside `SqliteEventRepository`'s append and
 * `SqliteProjectionRepository.save`, the RAW rows carry no secret, the
 * in-memory returns match the durable rows byte-for-byte, and everything
 * unregistered — enums, ids, hashes, whole unregistered projections — is
 * byte-identical. ALL secret material below is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { idempotencyKey, runId, specHash, specVersionId } from '../domain/ids.js';
import {
  appendableEvent,
  draftEvent,
  type AppendableEvent,
  type DomainEvent,
  type DomainEventType,
  type EventPayloads,
} from '../domain/events.js';
import {
  EVENT_FREE_TEXT_FIELDS,
  PROJECTION_FREE_TEXT_FIELDS,
  redactEventPayload,
  redactProjectionState,
} from './metadata-redaction.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN = runId('run_meta_redact_1');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');

/** SYNTHETIC planted secret (the review's probe shape). Never a real credential. */
const SECRET_VALUE = 'w33-synthetic-secret-0001';
const PLANTED = `API_KEY=${SECRET_VALUE}`;

function ev<T extends DomainEventType>(type: T, payload: EventPayloads[T], key: string): DomainEvent {
  return draftEvent({
    type,
    runId: RUN,
    payload,
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

// ---------------------------------------------------------------------------
// The registered field map itself (pure, no DB)
// ---------------------------------------------------------------------------
describe('W3-3 registered free-text field map', () => {
  it('registers EXACTLY the reviewed user-origin fields — no blind deep-walk creep', () => {
    // Pinned on purpose: adding a field here must be a deliberate spec
    // decision (enums/ids/hashes must never drift into the registry).
    expect(EVENT_FREE_TEXT_FIELDS).toEqual({
      'spec.revise.requested': [{ field: 'feedback', form: 'prose' }],
    });
    expect(PROJECTION_FREE_TEXT_FIELDS).toEqual({
      run_meta: [{ field: 'goal', form: 'prose' }],
      spec_draft: [
        { field: 'goal', form: 'prose' },
        { field: 'canonicalSpec', form: 'prose' },
      ],
      role_round: [{ field: 'inputs', form: 'stringified_json' }],
      implement_verify_loop: [{ field: 'taskScope', form: 'prose' }],
    });
  });

  it('returns the SAME reference for unregistered types and for secret-free registered fields', () => {
    const unregistered = { specVersionId: 'spec_1', specHash: 'hash_1', approvedBy: 'human' };
    expect(redactEventPayload('spec.approved', unregistered)).toBe(unregistered);

    const clean = { feedback: 'tighten the error copy' };
    expect(redactEventPayload('spec.revise.requested', clean)).toBe(clean);

    const cleanState = { goal: 'ship the flag', workspacePath: '/ws' };
    expect(redactProjectionState('run_meta', cleanState)).toBe(cleanState);
    expect(redactProjectionState('engine_state', cleanState)).toBe(cleanState);
  });

  it('redacts ONLY the registered field and never mutates the input', () => {
    const payload = { feedback: `please rotate ${PLANTED} first` };
    const redacted = redactEventPayload('spec.revise.requested', payload);
    expect(redacted).not.toBe(payload);
    expect(redacted.feedback).not.toContain(SECRET_VALUE);
    expect(redacted.feedback).toContain('[REDACTED:');
    expect(payload.feedback).toContain(SECRET_VALUE); // input untouched

    // A registered field whose value is not a string passes through whole.
    const odd = { inputs: 42 } as unknown as { inputs: string };
    expect(redactProjectionState('role_round', odd)).toBe(odd);
  });
});

// ---------------------------------------------------------------------------
// The two repository boundaries (raw rows + readbacks)
// ---------------------------------------------------------------------------
describe.each(DRIVER_KINDS)('W3-3 metadata-sink redaction at the repositories (%s)', (kind) => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await openTestDatabase({ kind, file: false });
  });
  afterEach(() => {
    handle.close();
    handle.cleanup();
  });

  function rawEventPayload(type: string): string {
    const row = handle.db.driver
      .prepare('SELECT payload_json FROM events WHERE run_id = ? AND type = ?')
      .get<{ payload_json: string }>([RUN, type]);
    expect(row).toBeDefined();
    return row!.payload_json;
  }

  function rawProjectionState(name: string): string {
    const row = handle.db.driver
      .prepare('SELECT state_json FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .get<{ state_json: string }>([RUN, name]);
    expect(row).toBeDefined();
    return row!.state_json;
  }

  it('spec.revise.requested feedback: raw DB row redacted; returned event, listByRun, and dedup readback all match the row', () => {
    const outcome = handle.db.events.append(
      appendableEvent(ev('spec.revise.requested', { feedback: `too broad — and ${PLANTED} leaked in here` }, 'revise-1'),
    ));

    // Raw row: the planted secret is gone, a redaction marker is present.
    const raw = rawEventPayload('spec.revise.requested');
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).toContain('[REDACTED:');

    // In-memory === durable: the returned event carries the ROW's payload
    // (the live projection fold and a later replay fold identical bytes).
    expect(outcome.event.payload).toEqual(JSON.parse(raw));
    const feedback = (outcome.event.payload as { feedback: string }).feedback;
    expect(feedback).not.toContain(SECRET_VALUE);
    expect(feedback).toContain('too broad'); // non-secret prose survives

    // Every readback surface agrees.
    const replayed = handle.db.events.listByRun(RUN);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.payload).toEqual(outcome.event.payload);

    // A redelivered append under the same key returns the redacted row too.
    const deduped = handle.db.events.append(
      appendableEvent(ev('spec.revise.requested', { feedback: `too broad — and ${PLANTED} leaked in here` }, 'revise-1'),
    ));
    expect(deduped.deduped).toBe(true);
    expect(deduped.event.payload).toEqual(outcome.event.payload);
  });

  it('unregistered event payloads are byte-identical: hashes/ids/enums never rewritten', () => {
    const payload = {
      specVersionId: specVersionId('spec_v1'),
      specHash: specHash('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'),
      approvedBy: 'human' as const,
    };
    // B2 round 5: this suite tests the persistence layer's PAYLOAD handling, so
    // it legitimately needs an approval row in the store. `appendableEvent()`
    // refuses one by design, so the type is forced openly — the deliberate,
    // greppable act the binding constraint is meant to require.
    handle.db.events.append(
      ev('spec.approved', payload, 'approve-1') as unknown as AppendableEvent,
    );
    // The raw row is EXACTLY the stringified input — no field touched.
    expect(rawEventPayload('spec.approved')).toBe(JSON.stringify(payload));
  });

  it('run_meta / spec_draft / implement_verify_loop saves: raw rows redacted, ids and hashes byte-identical', () => {
    handle.db.projections.save(RUN, 'run_meta', {
      goal: `Ship the toggle. ${PLANTED}`,
      workspacePath: '/ws/repo',
      coordinator: { harness: 'claude', model: 'opus', effort: 'low' },
    });
    const rawMeta = rawProjectionState('run_meta');
    expect(rawMeta).not.toContain(SECRET_VALUE);
    expect(rawMeta).toContain('[REDACTED:');
    expect(rawMeta).toContain('/ws/repo'); // unregistered fields untouched

    const draft = {
      specVersionId: specVersionId('spec_v2'),
      specHash: specHash('feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface'),
      canonicalSpec: `{\n  "goal": "Ship the toggle. ${PLANTED}"\n}`,
      goal: `Ship the toggle. ${PLANTED}`,
      criteria: [],
      proposedImplementorProfile: 'codex:gpt-5.6-terra',
      proposedVerifierProfile: 'claude:opus',
      revision: 1,
    };
    handle.db.projections.save(RUN, 'spec_draft', draft);
    const rawDraft = rawProjectionState('spec_draft');
    expect(rawDraft).not.toContain(SECRET_VALUE);
    const storedDraft = JSON.parse(rawDraft) as typeof draft;
    expect(storedDraft.goal).toContain('[REDACTED:');
    expect(storedDraft.canonicalSpec).toContain('[REDACTED:');
    // Hash/id/profile fields byte-identical.
    expect(storedDraft.specVersionId).toBe(String(draft.specVersionId));
    expect(storedDraft.specHash).toBe(String(draft.specHash));
    expect(storedDraft.proposedImplementorProfile).toBe(draft.proposedImplementorProfile);
    expect(storedDraft.revision).toBe(1);

    handle.db.projections.save(RUN, 'implement_verify_loop', {
      assignmentId: 'asg_1',
      specHash: 'hash_loop',
      taskScope: `Implement it; do NOT commit ${PLANTED}`,
      destinationLabel: 'main',
      destinationRef: 'refs/heads/main',
    });
    const rawLoop = rawProjectionState('implement_verify_loop');
    expect(rawLoop).not.toContain(SECRET_VALUE);
    expect(JSON.parse(rawLoop)).toMatchObject({ assignmentId: 'asg_1', specHash: 'hash_loop' });
  });

  it('role_round inputs (stringified JSON) stay PARSEABLE after redaction — resume re-entry keeps its scope', () => {
    // The quoted-prose shape that would break under a plain text pass at
    // escape depth 1 (a consumed `\"` un-terminates the embedded string):
    // the registered form is the parse-based belt, so grammar survives.
    const taskScope = `Fix auth. The old password: "correct horse ${SECRET_VALUE}" must go.`;
    const inputs = JSON.stringify({ taskScope });
    handle.db.projections.save(RUN, 'role_round', {
      round: 2,
      role: 'implementor',
      stage: 'pending',
      inputs,
      specHash: 'hash_round',
      dispatchedAtSequence: 4,
    });

    const raw = rawProjectionState('role_round');
    expect(raw).not.toContain(SECRET_VALUE);
    const stored = JSON.parse(raw) as { inputs: string; specHash: string; round: number };
    expect(stored.specHash).toBe('hash_round');
    expect(stored.round).toBe(2);
    // The serialized inputs still parse (persistedTaskScope's contract) and
    // the scope's non-secret prose survives inside.
    const parsedInputs = JSON.parse(stored.inputs) as { taskScope?: string };
    expect(typeof parsedInputs.taskScope).toBe('string');
    expect(parsedInputs.taskScope).toContain('Fix auth.');
    expect(parsedInputs.taskScope).not.toContain(SECRET_VALUE);
    expect(parsedInputs.taskScope).toContain('[REDACTED:');
  });

  it('re-saving a round (pending→active→completed) is byte-stable: redaction is idempotent', () => {
    const inputs = JSON.stringify({ goal: `Ship it. ${PLANTED}` });
    const base = { round: 1, role: 'coordinator', stage: 'pending', inputs };
    handle.db.projections.save(RUN, 'role_round', base);
    const first = rawProjectionState('role_round');
    const storedInputs = (JSON.parse(first) as { inputs: string }).inputs;

    handle.db.projections.save(RUN, 'role_round', {
      ...base,
      stage: 'active',
      inputs: storedInputs, // the readback (already redacted) is re-saved
    });
    const second = JSON.parse(rawProjectionState('role_round')) as { inputs: string; stage: string };
    expect(second.stage).toBe('active');
    expect(second.inputs).toBe(storedInputs); // no double-redaction drift
  });

  it('an UNREGISTERED projection is stored verbatim — the registry, not a deep-walk, decides', () => {
    // Deliberate: a secret-shaped SYNTHETIC string inside an unregistered
    // projection persists byte-for-byte. That is the registered-fields-only
    // contract (a blind walk over every payload is exactly what W3-3
    // forbids — enums/ids/hashes must never be rewritten by lookalike
    // matching); unregistered projections carry no user-origin free text.
    const state = { note: `benign engine detail mentioning ${PLANTED}` };
    handle.db.projections.save(RUN, 'engine_state', state);
    expect(rawProjectionState('engine_state')).toBe(JSON.stringify(state));
  });

  it('replay/recover folds the SAME redacted bytes the live path folded', () => {
    handle.db.events.append(
      appendableEvent(ev('spec.revise.requested', { feedback: `narrow the scope; ${PLANTED}` }, 'revise-replay'),
    ));
    type Fold = { seen: readonly string[] };
    const reduce = (state: Fold, event: DomainEvent): Fold =>
      event.type === 'spec.revise.requested'
        ? { seen: [...state.seen, (event.payload as { feedback: string }).feedback] }
        : state;

    const recovered = handle.db.projections.recover<Fold>(RUN, 'w33_probe', reduce, { seen: [] });
    expect(recovered.state.seen).toHaveLength(1);
    expect(recovered.state.seen[0]).not.toContain(SECRET_VALUE);
    expect(recovered.state.seen[0]).toContain('[REDACTED:');

    // A second recover (nothing new to fold) returns the stored record
    // unchanged — redaction never perturbs the recover fixpoint.
    const again = handle.db.projections.recover<Fold>(RUN, 'w33_probe', reduce, { seen: [] });
    expect(again.state).toEqual(recovered.state);
  });
});
