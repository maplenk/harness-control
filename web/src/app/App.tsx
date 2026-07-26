import {
  FIXTURE_OVERVIEW,
  FIXTURE_RUNS,
  FIXTURE_SELECTED_RUN_ID,
} from '../fixtures/runs';
import { FleetRail } from '../shell/FleetRail';
import { RunOverview } from '../screens/RunOverview';

/**
 * Fixture-backed shell: rail | main, fed only from static fixture data.
 * No client reducer, no network, no daemon, no serve claim.
 */
export function App() {
  return (
    <div
      data-testid="app-shell"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-0)',
        color: 'var(--tx-1)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px',
          borderBottom: '1px solid var(--bd)',
          background: 'var(--bg-1)',
        }}
      >
        <div
          style={{
            width: 16,
            height: 16,
            border: '1.5px solid var(--accent)',
            borderRadius: 3,
            position: 'relative',
          }}
          aria-hidden="true"
        >
          <div
            style={{
              position: 'absolute',
              inset: 3,
              background: 'var(--accent)',
              borderRadius: 1,
              opacity: 0.85,
            }}
          />
        </div>
        <span style={{ fontWeight: 650, letterSpacing: '0.2px' }}>
          Harness Control
        </span>
      </header>
      <div
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
        }}
      >
        <FleetRail runs={FIXTURE_RUNS} selectedRunId={FIXTURE_SELECTED_RUN_ID} />
        <RunOverview overview={FIXTURE_OVERVIEW} />
      </div>
    </div>
  );
}
