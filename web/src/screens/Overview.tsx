import type { EventWire, RunWire } from '../client/types';
import type { RunOverviewData } from '../fixtures/types';
import { Badge, Card, EmptyState } from '../components/Ui';
import { RunOverview } from './RunOverview';

const WORKFLOW = ['Spec', 'Approval', 'Implement', 'Verify', 'Merge-ready'] as const;

export function Overview({
  run,
  events,
  busy,
  onCommand,
}: {
  readonly run?: RunWire;
  readonly events: readonly EventWire[];
  readonly busy: boolean;
  readonly onCommand: (
    pathname: string,
    body?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}) {
  if (run === undefined) {
    return (
      <main className="screen">
        <EmptyState title="Select a run" detail="Choose a run from Fleet to open its control room." />
      </main>
    );
  }
  const overview = toOverview(run);
  const primaryAction = actionFor(run, busy, onCommand);
  return (
    <main className="screen screen--flush">
      <RunOverview overview={overview} />
      <div className="overview-body">
        {run.suspensionDetail !== null ? (
          <div className={`notice notice--${run.suspension === 'breaker_open' ? 'red' : 'amber'}`}>
            <strong>{run.suspension.replaceAll('_', ' ')}</strong>
            <span>{run.suspensionDetail}</span>
          </div>
        ) : null}
        <div className="overview-toolbar">
          <div className="badge-row">
            <Badge tone={run.approval.mode === 'auto' ? 'amber' : 'neutral'}>
              approval: {run.approval.mode}
            </Badge>
            <Badge tone="neutral">{run.executionMode}</Badge>
            <Badge tone={run.childActive ? 'accent' : 'neutral'}>
              child {run.childActive ? 'active' : 'idle'}
            </Badge>
          </div>
          {primaryAction}
        </div>
        <div className="two-column">
          <Card title="Coordinator plan">
            {run.spec === undefined ? (
              <EmptyState
                title="Spec is being drafted"
                detail="The immutable plan will appear after Coordinator validation."
              />
            ) : (
              <ol className="task-list">
                {run.spec.tasks.map((task) => (
                  <li key={task.id}>
                    <span className="mono task-id">{task.id}</span>
                    <div>
                      <strong>{task.description}</strong>
                      <small>
                        {task.dependsOn.length > 0
                          ? `depends on ${task.dependsOn.join(', ')}`
                          : 'no dependencies'}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title={`Assignment board · ${run.assignments.length}`}>
            <div className="assignment-board">
              {run.assignments.map((assignment) => (
                <article className="assignment-tile" key={assignment.id}>
                  <div>
                    <Badge tone={assignmentTone(assignment.stage)}>{assignment.stage}</Badge>
                    <span className="mono subtle">{assignment.id}</span>
                  </div>
                  <strong>{assignment.taskScope}</strong>
                  <small>
                    {assignment.repo} · {assignment.writeScope.join(', ') || 'whole root'}
                  </small>
                  <div className="chip-row">
                    {assignment.criteria.map((criterion) => (
                      <span className="chip mono" key={criterion}>
                        {criterion}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </Card>
        </div>
        <Card title="Live progress" action={<span className="mono subtle">cursor {run.asOfSequence}</span>}>
          {events.length === 0 ? (
            <EmptyState
              title="No activity after the snapshot"
              detail="Polling resumes from the server’s exclusive event cursor."
            />
          ) : (
            <div className="event-list">
              {events.slice(-12).reverse().map((event) => (
                <div className="event-row" key={event.sequence}>
                  <span className="mono event-seq">{event.sequence}</span>
                  <strong>{event.type}</strong>
                  <time>{formatTime(event.occurredAt)}</time>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

function toOverview(run: RunWire): RunOverviewData {
  const base = run.repositories[0]?.baseCommit;
  const roleLanes = (['coordinator', 'implementor', 'verifier'] as const).map((role) => {
    const model = run.models[role]?.effective ?? run.models[role]?.desired;
    return {
      role: `${role[0]?.toUpperCase() ?? ''}${role.slice(1)}` as
        | 'Coordinator'
        | 'Implementor'
        | 'Verifier',
      harness: model?.harness ?? 'not dispatched',
      model: model?.model ?? 'pending',
      effort: model?.effort ?? 'default',
    };
  });
  return {
    id: run.runId,
    goal: run.goal,
    phase: run.phase as RunOverviewData['phase'],
    phaseLabel: `${run.phase.replaceAll('_', ' ')} · ${run.operation.replaceAll('_', ' ')}`,
    suspension: run.suspension as RunOverviewData['suspension'],
    operation: run.operation as RunOverviewData['operation'],
    commit: base === undefined ? 'base commit pending' : `${base.slice(0, 12)} · ${run.repositories[0]?.path}`,
    costMeasured: run.cost.measuredUsd,
    costEstimated: run.cost.estimatedUsd,
    roleLanes,
    workflowNodes: [...WORKFLOW],
  };
}

function actionFor(
  run: RunWire,
  busy: boolean,
  onCommand: (
    pathname: string,
    body?: Readonly<Record<string, unknown>>,
  ) => Promise<void>,
) {
  if (run.phase === 'awaiting_approval' && run.approval.specVersionId !== undefined) {
    return (
      <button
        className="button button--primary"
        disabled={busy}
        type="button"
        onClick={() =>
          void onCommand(`/api/runs/${encodeURIComponent(run.runId)}/approve`, {
            specVersionId: run.approval.specVersionId,
            ...(run.approval.specHash !== undefined ? { specHash: run.approval.specHash } : {}),
          })
        }
      >
        Approve exact spec
      </button>
    );
  }
  if (run.phase === 'approved') {
    return (
      <button
        className="button button--primary"
        disabled={busy}
        type="button"
        onClick={() =>
          void onCommand(`/api/runs/${encodeURIComponent(run.runId)}/run`, {
            executionMode: run.executionMode,
            ...(run.models['implementor']?.effective !== undefined
              ? { implementor: run.models['implementor'].effective }
              : {}),
            ...(run.models['verifier']?.effective !== undefined
              ? { verifier: run.models['verifier'].effective }
              : {}),
          })
        }
      >
        Start implementation
      </button>
    );
  }
  if (!['cancelled', 'failed', 'merge_ready'].includes(run.phase)) {
    return (
      <button
        className="button button--danger"
        disabled={busy}
        type="button"
        onClick={() => void onCommand(`/api/runs/${encodeURIComponent(run.runId)}/cancel`)}
      >
        Cancel run
      </button>
    );
  }
  return null;
}

function assignmentTone(
  stage: RunWire['assignments'][number]['stage'],
): 'neutral' | 'accent' | 'green' | 'red' {
  if (stage === 'delivered') return 'green';
  if (stage === 'no_deliverable') return 'red';
  if (stage === 'running') return 'accent';
  return 'neutral';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
