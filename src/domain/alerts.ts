/**
 * P4b-1 alerts — PURE derivation (§5cc "P4b design FINALIZED").
 *
 * An `alert.raised` supporting event rides its triggering transition inside ONE
 * `#atomicEngineWrite` transaction (like `checkpoint.recorded` rides
 * `pauseForLimit`): the app service scans a transition's engine-emitted
 * `notify.requested` effects for an ALERTABLE topic and folds one `alert.raised`
 * per hit. That is the single emit point — an alert can never exist without its
 * cause (the notify effect that produced it) and vice-versa.
 *
 * Delivery is DERIVED from the log (F3 pattern, NOT a separate delivered cursor
 * as the source of truth): un-acked = an `alert.raised` with no matching later
 * `alert.delivered`. IDs/idempotency keys are DERIVED from the trigger's key so
 * replay reproduces identical bytes and re-delivery dedups by `(alertId, sink)`.
 *
 * This module is pure/deterministic (no clock, id factory, or network); the
 * §17.1 redaction of `detail` is applied through a `redact` callback the caller
 * injects (keeping the domain layer free of a redaction dependency).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import {
  deriveIdempotencyKey,
  draftEvent,
  type AlertKind,
  type AlertSink,
  type DomainEvent,
  type EventOfType,
  type NotifyTopic,
} from './events.js';
import { alertId as toAlertId, type AlertId, type ProcessGenerationId, type RunId } from './ids.js';
import type { RoleName } from './state.js';

// ---------------------------------------------------------------------------
// Notify topic → alert kind (the alertable subset)
// ---------------------------------------------------------------------------
/**
 * The three wave-1 alertable notify topics and the alert kind each maps to.
 * `paused_user`, `rss_soft`, `merge_ready`, `run_failed`, `failover_exhausted`,
 * `unknown_provider_error` deliberately do NOT raise an alert (they are not
 * operator-actionable incidents in the §5cc sense). `respawn` has no notify
 * topic yet — it is emitted directly by the wave-2 successor spine.
 */
export const NOTIFY_TOPIC_TO_ALERT_KIND: Partial<Record<NotifyTopic, AlertKind>> = {
  paused_limit: 'limit_paused',
  interrupted: 'crash',
  breaker_open: 'breaker_open',
};

export function alertKindForTopic(topic: NotifyTopic): AlertKind | undefined {
  return NOTIFY_TOPIC_TO_ALERT_KIND[topic];
}

export function isAlertableNotifyTopic(topic: NotifyTopic): boolean {
  return alertKindForTopic(topic) !== undefined;
}

// ---------------------------------------------------------------------------
// alert.raised derivation
// ---------------------------------------------------------------------------
/** The contextual facts the engine state / spawn context supplies to an alert. */
export interface AlertRaisedContext {
  readonly role: RoleName;
  readonly generationId?: ProcessGenerationId;
  /** Extra, possibly sensitive detail (a crash message, a limit provider) —
   * merged after the notify message and redacted before it is stored. */
  readonly detail?: string;
}

export interface DeriveAlertRaisedInput {
  readonly trigger: DomainEvent;
  /** The transition's engine-emitted effects (the `notify.requested` source). */
  readonly emitted: readonly DomainEvent[];
  readonly context: AlertRaisedContext;
  /** The §17.1 redaction path (e.g. `redactText`). */
  readonly redact: (text: string) => string;
}

/**
 * Derive the `alert.raised` events that ride a transition: one per engine-emitted
 * `notify.requested` whose topic maps to an alert kind. The alertId AND the
 * event idempotency key both derive from the trigger's key + the notify's index
 * among the emitted effects — so the pair is replay-stable and the append path
 * dedups a re-applied trigger's alert idempotently.
 */
export function deriveAlertRaisedEvents(input: DeriveAlertRaisedInput): EventOfType<'alert.raised'>[] {
  const out: EventOfType<'alert.raised'>[] = [];
  input.emitted.forEach((event, index) => {
    if (event.type !== 'notify.requested') return;
    const topic = event.payload.topic;
    const kind = alertKindForTopic(topic);
    if (kind === undefined) return;
    const key = deriveIdempotencyKey(input.trigger.idempotencyKey, index, 'alert.raised');
    const detailSource =
      input.context.detail !== undefined
        ? `${event.payload.message} | ${input.context.detail}`
        : event.payload.message;
    out.push(
      draftEvent({
        type: 'alert.raised',
        runId: input.trigger.runId,
        idempotencyKey: key,
        occurredAt: input.trigger.occurredAt,
        payload: {
          alertId: toAlertId(String(key)),
          kind,
          role: input.context.role,
          ...(input.context.generationId !== undefined
            ? { generationId: input.context.generationId }
            : {}),
          topic,
          detail: input.redact(detailSource),
        },
      }),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// The alert read-model (projection folded from the log for `status`)
// ---------------------------------------------------------------------------
export interface AlertStatusEntry {
  readonly alertId: AlertId;
  readonly kind: AlertKind;
  readonly role: RoleName;
  readonly generationId?: ProcessGenerationId;
  readonly topic: NotifyTopic;
  readonly detail: string;
  readonly occurredAt: IsoTimestamp;
  readonly runId: RunId;
  /** True once ANY `alert.delivered` exists for this alert. */
  readonly delivered: boolean;
  /** The sinks this alert has been delivered to (sorted, deduped). */
  readonly sinks: readonly AlertSink[];
}

/**
 * The alert projection: fold `alert.raised` (identity + payload) and
 * `alert.delivered` (per-sink ack) from a run's event log into the `status`
 * read-model. Stable order by `occurredAt` then `alertId`. Derived on read (F3)
 * — no stored cursor is the source of truth for delivery.
 */
export function buildAlertStatusEntries(events: readonly DomainEvent[]): AlertStatusEntry[] {
  const raised = new Map<string, EventOfType<'alert.raised'>>();
  const deliveredBy = new Map<string, Set<AlertSink>>();
  for (const event of events) {
    if (event.type === 'alert.raised') {
      raised.set(String(event.payload.alertId), event);
    } else if (event.type === 'alert.delivered') {
      const id = String(event.payload.alertId);
      const set = deliveredBy.get(id) ?? new Set<AlertSink>();
      set.add(event.payload.sink);
      deliveredBy.set(id, set);
    }
  }
  const entries: AlertStatusEntry[] = [];
  for (const [id, event] of raised) {
    const sinks = [...(deliveredBy.get(id) ?? new Set<AlertSink>())].sort();
    entries.push({
      alertId: event.payload.alertId,
      kind: event.payload.kind,
      role: event.payload.role,
      ...(event.payload.generationId !== undefined
        ? { generationId: event.payload.generationId }
        : {}),
      topic: event.payload.topic,
      detail: event.payload.detail,
      occurredAt: event.occurredAt,
      runId: event.runId,
      delivered: sinks.length > 0,
      sinks,
    });
  }
  entries.sort((a, b) =>
    a.occurredAt < b.occurredAt
      ? -1
      : a.occurredAt > b.occurredAt
        ? 1
        : String(a.alertId) < String(b.alertId)
          ? -1
          : String(a.alertId) > String(b.alertId)
            ? 1
            : 0,
  );
  return entries;
}

// ---------------------------------------------------------------------------
// Un-acked delivery derivation (best-effort, at-least-once)
// ---------------------------------------------------------------------------
export interface PendingAlertDelivery {
  readonly alert: AlertStatusEntry;
  readonly sink: AlertSink;
}

/**
 * The still-un-acked `(alert, sink)` deliveries for a run: every raised alert
 * crossed with every configured sink it has NOT yet been delivered to. A
 * restart re-derives this from the log and delivers exactly the ones missing —
 * at-least-once across the restart, dedup by `(alertId, sink)`.
 */
export function deriveUnackedAlertDeliveries(
  events: readonly DomainEvent[],
  sinks: readonly AlertSink[],
): PendingAlertDelivery[] {
  const entries = buildAlertStatusEntries(events);
  const pending: PendingAlertDelivery[] = [];
  for (const alert of entries) {
    const already = new Set(alert.sinks);
    for (const sink of sinks) {
      if (!already.has(sink)) pending.push({ alert, sink });
    }
  }
  return pending;
}

/** The dedup idempotency key for an `alert.delivered` append. */
export function alertDeliveredIdempotencyKey(alertId: AlertId, sink: AlertSink): string {
  return `alert.delivered:${String(alertId)}:${sink}`;
}
