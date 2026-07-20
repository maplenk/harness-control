/**
 * P4b-1 alert delivery SINKS + the `Notifier` seam (§5cc).
 *
 * Delivery is best-effort/at-least-once. The service derives the un-acked
 * `(alert, sink)` pairs from the log (../domain/alerts.ts) and hands each to the
 * registered `Notifier` for that sink, then appends `alert.delivered`.
 *
 * Wave 1 ships two built-in sinks:
 *  - `stderr` — a real PUSH sink (writes a redacted one-line summary to the CLI
 *    process's stderr);
 *  - `status_json` — a PULL sink: the `status --json` alerts section renders the
 *    alert straight from the log, so "delivery" here only records that the alert
 *    is now surfaced there.
 *
 * The `Notifier` INTERFACE is the webhook/push/desktop seam. Wave 1 provides the
 * interface + a registry + a no-op adapter ONLY — deliberately NO concrete
 * network adapter. A wave-2 adapter is a new `Notifier` registered under its own
 * sink name; nothing else in the pipeline changes.
 */
import type { AlertSink } from '../domain/events.js';
import type { AlertStatusEntry } from '../domain/alerts.js';

export const STDERR_SINK: AlertSink = 'stderr';
export const STATUS_JSON_SINK: AlertSink = 'status_json';

/**
 * The delivery seam. `deliver` is best-effort — the service treats a THROW as
 * "not yet delivered" (the alert stays un-acked and a later pass retries), and a
 * normal return as delivered (it appends `alert.delivered{alertId, sink}`).
 * Synchronous by design: wave 1 has no network sink; a wave-2 adapter that needs
 * async work can enqueue and return, or the seam can widen to `Promise<void>`.
 */
export interface Notifier {
  readonly sink: AlertSink;
  deliver(alert: AlertStatusEntry): void;
}

/** The CLI `stderr` sink — a redacted one-line summary (detail is already
 * redacted at raise time; this never re-introduces raw text). */
export class StderrNotifier implements Notifier {
  readonly sink: AlertSink = STDERR_SINK;
  readonly #write: (line: string) => void;
  constructor(write: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)) {
    this.#write = write;
  }
  deliver(alert: AlertStatusEntry): void {
    const gen = alert.generationId !== undefined ? ` gen=${String(alert.generationId)}` : '';
    this.#write(
      `[alert:${alert.kind}] run=${String(alert.runId)} role=${alert.role}${gen} — ${alert.detail}`,
    );
  }
}

/** The `status --json` PULL sink: the alerts section derives from the log, so
 * delivery is a no-op that only records the alert is surfaced there. */
export class StatusJsonNotifier implements Notifier {
  readonly sink: AlertSink = STATUS_JSON_SINK;
  deliver(): void {
    /* pull sink — the status view renders straight from the log */
  }
}

/** The webhook/push/desktop seam placeholder (wave 2): a registered sink that
 * does nothing today. NO network. */
export class NoopNotifier implements Notifier {
  readonly sink: AlertSink;
  constructor(sink: AlertSink) {
    this.sink = sink;
  }
  deliver(): void {
    /* seam only — a concrete adapter arrives in wave 2 */
  }
}

/** Registry of sinks the service delivers to. Last registration per sink wins. */
export class NotifierRegistry {
  readonly #bySink = new Map<AlertSink, Notifier>();
  constructor(notifiers: readonly Notifier[]) {
    for (const notifier of notifiers) this.#bySink.set(notifier.sink, notifier);
  }
  sinks(): AlertSink[] {
    return [...this.#bySink.keys()];
  }
  get(sink: AlertSink): Notifier | undefined {
    return this.#bySink.get(sink);
  }
}

/** The default registry: `stderr` (real push) + `status_json` (pull view). */
export function defaultNotifierRegistry(stderrWrite?: (line: string) => void): NotifierRegistry {
  return new NotifierRegistry([new StderrNotifier(stderrWrite), new StatusJsonNotifier()]);
}
