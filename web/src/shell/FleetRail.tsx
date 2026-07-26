import type { FleetGroupTitle, FleetRun } from '../fixtures/types';
import { FIXTURE_GROUPS } from '../fixtures/runs';

export interface FleetRailProps {
  readonly runs: readonly FleetRun[];
  readonly selectedRunId: string;
}

function groupRuns(
  runs: readonly FleetRun[],
  groups: readonly FleetGroupTitle[],
): Array<{ title: FleetGroupTitle; runs: FleetRun[] }> {
  return groups
    .map((title) => ({
      title,
      runs: runs.filter((run) => run.group === title),
    }))
    .filter((group) => group.runs.length > 0);
}

export function FleetRail({ runs, selectedRunId }: FleetRailProps) {
  const populated = groupRuns(runs, FIXTURE_GROUPS);

  return (
    <aside
      aria-label="Fleet rail"
      data-testid="fleet-rail"
      style={{
        flex: '0 0 280px',
        borderRight: '1px solid var(--bd)',
        background: 'var(--bg-1)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--bd)',
          fontSize: '11px',
          fontWeight: 650,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--tx-3)',
        }}
      >
        Fleet
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {populated.map((group) => (
          <section key={group.title} data-testid={`fleet-group-${group.title}`}>
            <h2
              style={{
                margin: 0,
                padding: '11px 12px 5px',
                fontSize: '10.5px',
                fontWeight: 650,
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                color: 'var(--tx-3)',
              }}
            >
              {group.title}
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {group.runs.map((run) => {
                const selected = run.id === selectedRunId;
                return (
                  <li
                    key={run.id}
                    data-testid={`fleet-row-${run.id}`}
                    data-run-id={run.id}
                    aria-current={selected ? 'true' : undefined}
                    style={{
                      padding: 'var(--row-pad)',
                      borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                      background: selected ? 'var(--bg-3)' : 'transparent',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          flex: '0 0 auto',
                          marginTop: 1,
                          fontSize: 12,
                          lineHeight: 1.1,
                          color:
                            run.suspension === 'breaker_open'
                              ? 'var(--red)'
                              : run.suspension !== 'none' ||
                                  run.group === 'Needs attention'
                                ? 'var(--amber)'
                                : run.phase === 'merge_ready'
                                  ? 'var(--green)'
                                  : 'var(--accent)',
                        }}
                      >
                        {run.glyph}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: '12.5px',
                            color: 'var(--tx-1)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {run.goal}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginTop: 3,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 11,
                              color:
                                run.suspension === 'breaker_open'
                                  ? 'var(--red)'
                                  : run.phase === 'merge_ready'
                                    ? 'var(--green)'
                                    : 'var(--amber)',
                            }}
                          >
                            {run.fleetLabel}
                          </span>
                          <span style={{ fontSize: '10.5px', color: 'var(--tx-3)' }}>
                            ·
                          </span>
                          <span style={{ fontSize: '10.5px', color: 'var(--tx-3)' }}>
                            {run.roleTag}
                          </span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
