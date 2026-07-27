import type { FleetRunWire } from '../client/types';
import { Badge, Card, EmptyState, ScreenHeader } from '../components/Ui';

export function Fleet({
  runs,
  onSelect,
  onNewRun,
}: {
  readonly runs: readonly FleetRunWire[];
  readonly onSelect: (runId: string) => void;
  readonly onNewRun: () => void;
}) {
  const active = runs.filter((run) => run.uiState === 'working' || run.uiState === 'starting');
  const attention = runs.filter(
    (run) => run.uiState === 'waiting_on_you' || run.uiState === 'breaker_open',
  );
  const implementors = runs.reduce((sum, run) => sum + run.activeImplementors, 0);
  return (
    <main className="screen">
      <ScreenHeader
        eyebrow="Operator workspace"
        title="Fleet"
        detail="Every run is projected by the server. Events drive the activity feed, never authoritative state."
        action={
          <button className="button button--primary" type="button" onClick={onNewRun}>
            New run
          </button>
        }
      />
      <div className="metric-grid">
        <Card>
          <div className="metric">
            <span>Active runs</span>
            <strong>{active.length}</strong>
          </div>
        </Card>
        <Card tone={attention.length > 0 ? 'amber' : 'default'}>
          <div className="metric">
            <span>Needs attention</span>
            <strong>{attention.length}</strong>
          </div>
        </Card>
        <Card>
          <div className="metric">
            <span>Live implementors</span>
            <strong>{implementors}</strong>
          </div>
        </Card>
      </div>
      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          detail="Create a run to coordinate an implementation and watch it appear here."
        />
      ) : (
        <div className="run-grid">
          {runs.map((run) => (
            <button
              className="run-card"
              key={run.runId}
              type="button"
              onClick={() => onSelect(run.runId)}
            >
              <div className="run-card__top">
                <Badge tone={toneFor(run.uiState)}>{labelFor(run.uiState)}</Badge>
                <span className="mono subtle">{shortId(run.runId)}</span>
              </div>
              <strong>{run.goal}</strong>
              <div className="run-card__meta">
                <span>{run.repositories.map((repo) => repo.id).join(', ')}</span>
                <span>{run.activeImplementors} implementors</span>
                <span>{run.phase.replaceAll('_', ' ')}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

function labelFor(state: FleetRunWire['uiState']): string {
  return state.replaceAll('_', ' ');
}

function toneFor(
  state: FleetRunWire['uiState'],
): 'neutral' | 'accent' | 'amber' | 'green' | 'red' | 'purple' {
  if (state === 'done') return 'green';
  if (state === 'breaker_open' || state === 'stopped') return 'red';
  if (state === 'waiting_on_you' || state === 'paused_limit') return 'amber';
  if (state === 'working' || state === 'starting') return 'accent';
  if (state === 'handed_off') return 'purple';
  return 'neutral';
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value;
}
