import type { RunOverviewData } from '../fixtures/types';

export interface RunOverviewProps {
  readonly overview: RunOverviewData;
}

export function RunOverview({ overview }: RunOverviewProps) {
  const measured = overview.costMeasured.toFixed(2);
  const estimated = overview.costEstimated.toFixed(2);

  return (
    <section
      aria-label="Run overview"
      data-testid="run-overview"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-0)',
        overflow: 'auto',
      }}
    >
      {/* Run header */}
      <header
        data-testid="run-header"
        style={{
          flex: '0 0 auto',
          padding: '14px 20px 16px',
          borderBottom: '1px solid var(--bd)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 17,
                  fontWeight: 650,
                  color: 'var(--tx-1)',
                }}
              >
                {overview.goal}
              </h1>
              <span
                className="mono"
                data-testid="run-id"
                style={{ fontSize: 11, color: 'var(--tx-3)' }}
              >
                {overview.id}
              </span>
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: 'var(--tx-2)',
              }}
            >
              <span className="mono">{overview.commit}</span>
            </div>
          </div>
          <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
            <div
              data-testid="phase-label"
              style={{
                fontWeight: 600,
                fontSize: '13.5px',
                color: 'var(--tx-1)',
              }}
            >
              {overview.phaseLabel}
            </div>
          </div>
        </div>

        {/* Cost split */}
        <div
          data-testid="cost-split"
          style={{
            marginTop: 14,
            fontSize: '11.5px',
            color: 'var(--tx-3)',
          }}
        >
          <span style={{ color: 'var(--tx-2)' }}>Cost</span>{' '}
          <span className="mono" style={{ color: 'var(--tx-1)' }}>
            ${measured}
          </span>{' '}
          measured <span style={{ color: 'var(--tx-3)' }}>+</span>{' '}
          <span className="mono" style={{ color: 'var(--amber)' }}>
            ${estimated}
          </span>{' '}
          est
        </div>

        {/* Workflow rail */}
        <ol
          data-testid="workflow-rail"
          aria-label="Workflow"
          style={{
            listStyle: 'none',
            margin: '16px 0 0',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 0,
          }}
        >
          {overview.workflowNodes.map((node, index) => (
            <li
              key={node}
              data-testid={`workflow-node-${node}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    border: '2px solid var(--accent)',
                    background:
                      index <= 3 ? 'var(--accent)' : 'var(--bg-0)',
                    color: index <= 3 ? '#04211f' : 'var(--tx-3)',
                  }}
                >
                  {index < 3 ? '✓' : index === 3 ? '●' : index + 1}
                </span>
                <span
                  style={{
                    fontSize: '10.5px',
                    color: index === 3 ? 'var(--accent)' : 'var(--tx-2)',
                  }}
                >
                  {node}
                </span>
              </div>
              {index < overview.workflowNodes.length - 1 ? (
                <span
                  aria-hidden="true"
                  style={{
                    width: 34,
                    height: 2,
                    background: index < 3 ? 'var(--accent)' : 'var(--bd)',
                    margin: '0 2px',
                    alignSelf: 'flex-start',
                    marginTop: 10,
                  }}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </header>

      {/* Role lanes */}
      <div
        data-testid="role-lanes"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          padding: 20,
        }}
      >
        {overview.roleLanes.map((lane) => (
          <article
            key={lane.role}
            data-testid={`role-lane-${lane.role}`}
            style={{
              border: '1px solid var(--bd)',
              borderRadius: 8,
              background: 'var(--bg-1)',
              padding: 14,
            }}
          >
            <h2
              style={{
                margin: '0 0 10px',
                fontSize: 13,
                fontWeight: 650,
                color:
                  lane.role === 'Coordinator'
                    ? 'var(--accent)'
                    : lane.role === 'Implementor'
                      ? 'var(--purple)'
                      : 'var(--green)',
              }}
            >
              {lane.role}
            </h2>
            <dl
              style={{
                margin: 0,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '6px 10px',
                fontSize: 12,
              }}
            >
              <dt style={{ color: 'var(--tx-3)', margin: 0 }}>Harness</dt>
              <dd style={{ color: 'var(--tx-1)', margin: 0 }}>{lane.harness}</dd>
              <dt style={{ color: 'var(--tx-3)', margin: 0 }}>Model</dt>
              <dd className="mono" style={{ color: 'var(--tx-1)', margin: 0 }}>
                {lane.model}
              </dd>
              <dt style={{ color: 'var(--tx-3)', margin: 0 }}>Effort</dt>
              <dd style={{ color: 'var(--tx-1)', margin: 0 }}>{lane.effort}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
