import { useEffect, useState, type FormEvent } from 'react';
import type { MetaWire, RoleSpec, RunWire } from '../client/types';
import { Badge, Card, EmptyState, ScreenHeader } from '../components/Ui';

export function AssignmentDetail({
  run,
  features,
  busy,
  onCommand,
}: {
  readonly run?: RunWire;
  readonly features?: MetaWire['features'];
  readonly busy: boolean;
  readonly onCommand: (
    pathname: string,
    body?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [target, setTarget] = useState<RoleSpec>({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  useEffect(() => {
    if (run !== undefined && !run.assignments.some((item) => item.id === selectedId)) {
      setSelectedId(run.assignments[0]?.id ?? '');
    }
  }, [run, selectedId]);
  if (run === undefined) {
    return (
      <main className="screen">
        <EmptyState title="Select a run" detail="Assignment details are scoped to one run." />
      </main>
    );
  }
  const assignment = run.assignments.find((item) => item.id === selectedId) ?? run.assignments[0];
  if (assignment === undefined) {
    return (
      <main className="screen">
        <EmptyState title="No assignments yet" detail="The Coordinator decomposition will appear here." />
      </main>
    );
  }
  const submitSwitch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await onCommand(`/api/runs/${encodeURIComponent(run.runId)}/switch-model`, {
      role: 'implementor',
      target,
      assignmentId: assignment.id,
    });
  };
  const model = assignment.implementor ?? run.models['implementor']?.effective;
  const desired = run.models['implementor']?.desired;
  return (
    <main className="screen">
      <ScreenHeader
        eyebrow={`Run · ${run.runId}`}
        title="Assignment detail"
        detail="Inspect containment, output state and the target used at the next spawn boundary."
        action={
          <select value={assignment.id} onChange={(event) => setSelectedId(event.target.value)}>
            {run.assignments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        }
      />
      <div className="two-column">
        <Card
          title={assignment.id}
          action={<Badge tone={assignment.stage === 'delivered' ? 'green' : 'accent'}>{assignment.stage}</Badge>}
        >
          <dl className="detail-grid">
            <dt>Repository</dt>
            <dd>{assignment.repo}</dd>
            <dt>Execution</dt>
            <dd>{assignment.executionMode}</dd>
            <dt>Round</dt>
            <dd>{assignment.round ?? 'not started'}</dd>
            <dt>Depends on</dt>
            <dd>{assignment.dependsOn.join(', ') || 'nothing'}</dd>
            <dt>Write scope</dt>
            <dd className="mono">{assignment.writeScope.join(', ') || '(whole root)'}</dd>
          </dl>
          <div className="task-scope">
            <span>Task scope</span>
            <p>{assignment.taskScope}</p>
          </div>
          {assignment.diagnostic !== undefined ? (
            <div className="notice notice--red">{assignment.diagnostic}</div>
          ) : null}
        </Card>
        <Card title="Harness and model">
          <div className="model-line">
            <span>Effective</span>
            <strong className="mono">
              {model === undefined ? 'not dispatched' : `${model.harness}:${model.model}`}
            </strong>
          </div>
          <div className="model-line">
            <span>Desired</span>
            <strong className="mono">
              {desired === undefined ? 'none' : `${desired.harness}:${desired.model}`}
            </strong>
          </div>
          <form className="switch-form" onSubmit={(event) => void submitSwitch(event)}>
            <label className="field">
              <span>Harness</span>
              <select
                value={target.harness}
                onChange={(event) =>
                  setTarget({ ...target, harness: event.target.value as RoleSpec['harness'] })
                }
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="grok">Grok Build</option>
                <option value="opencode">OpenCode</option>
              </select>
            </label>
            <label className="field field--wide">
              <span>Model</span>
              <input
                className="mono"
                value={target.model}
                onChange={(event) => setTarget({ ...target, model: event.target.value })}
              />
            </label>
            <button className="button button--primary" disabled={busy} type="submit">
              Switch at next boundary
            </button>
          </form>
          {features?.assignmentModelSwitch !== true && run.assignments.length > 1 ? (
            <div className="notice notice--amber">
              The durable desired-model key is currently run + role. This request applies to the
              next Implementor spawn for the run, not only {assignment.id}.
            </div>
          ) : (
            <p className="field-help">
              Spawn-pinned providers apply this target at the next turn boundary. Raw provider
              transcripts do not cross vendor boundaries.
            </p>
          )}
        </Card>
      </div>
      <Card title="Recovery controls">
        <div className="button-row">
          <button
            className="button"
            disabled={busy || features?.assignmentModelSwitch !== true}
            type="button"
            onClick={() =>
              void onCommand(
                `/api/runs/${encodeURIComponent(run.runId)}/assignments/${encodeURIComponent(assignment.id)}/retry`,
              )
            }
          >
            Retry assignment
          </button>
          <button
            className="button"
            disabled={busy || features?.assignmentModelSwitch !== true}
            type="button"
          >
            Reassign
          </button>
          <span className="subtle">
            Disabled until the assignment-keyed scheduler/store lands; a run-wide retry is not
            presented as assignment isolation.
          </span>
        </div>
      </Card>
    </main>
  );
}
