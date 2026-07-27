import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchEvents,
  fetchFleet,
  fetchMeta,
  fetchRun,
  hasLiveConnection,
  postCommand,
} from '../client/api';
import type {
  EventWire,
  FleetRunWire,
  MetaWire,
  RunWire,
  UiState,
} from '../client/types';
import {
  FIXTURE_OVERVIEW,
  FIXTURE_RUNS,
  FIXTURE_SELECTED_RUN_ID,
} from '../fixtures/runs';
import type {
  FleetGroupTitle,
  FleetRun,
  OperationKind,
  RunPhase,
  SuspensionKind,
} from '../fixtures/types';
import { FleetRail } from '../shell/FleetRail';
import { AssignmentDetail } from '../screens/AssignmentDetail';
import { Fleet } from '../screens/Fleet';
import { NewRun } from '../screens/NewRun';
import { Overview } from '../screens/Overview';
import { Verification } from '../screens/Verification';

type Screen = 'fleet' | 'new' | 'overview' | 'assignment' | 'verification';

const NAV: readonly { readonly id: Screen; readonly label: string }[] = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'new', label: 'New run' },
  { id: 'overview', label: 'Overview' },
  { id: 'assignment', label: 'Assignment' },
  { id: 'verification', label: 'Verification' },
];

const LIVE = hasLiveConnection();
const PREVIEW_FLEET: readonly FleetRunWire[] = FIXTURE_RUNS.map((run) => ({
  runId: run.id,
  goal: run.goal,
  phase: run.phase,
  suspension: run.suspension,
  operation: run.operation,
  uiState: uiStateForFixture(run),
  repositories: [{ id: 'default', path: '/preview/repository' }],
  activeImplementors: run.phase === 'implementing' ? 1 : 0,
  updatedAt: '2026-07-27T09:00:00.000Z',
  asOfSequence: 42,
}));

const PREVIEW_META: MetaWire = {
  protocolVersion: 1,
  version: 'preview',
  features: {
    eventPolling: true,
    commands: false,
    multiRepository: false,
    assignmentModelSwitch: false,
  },
};

export function App() {
  const [screen, setScreen] = useState<Screen>('fleet');
  const [fleet, setFleet] = useState<readonly FleetRunWire[]>(LIVE ? [] : PREVIEW_FLEET);
  const [selectedRunId, setSelectedRunId] = useState(
    LIVE ? '' : FIXTURE_SELECTED_RUN_ID,
  );
  const [run, setRun] = useState<RunWire | undefined>(
    LIVE ? undefined : previewRun(FIXTURE_SELECTED_RUN_ID),
  );
  const [events, setEvents] = useState<readonly EventWire[]>([]);
  const [meta, setMeta] = useState<MetaWire | undefined>(LIVE ? undefined : PREVIEW_META);
  const [connection, setConnection] = useState<'live' | 'preview' | 'reconnecting'>(
    LIVE ? 'reconnecting' : 'preview',
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const cursorRef = useRef(0);

  const refreshFleet = useCallback(async (): Promise<void> => {
    if (!LIVE) return;
    try {
      const [nextFleet, nextMeta] = await Promise.all([fetchFleet(), fetchMeta()]);
      setFleet(nextFleet);
      setMeta(nextMeta);
      setConnection('live');
      setSelectedRunId((current) => current || nextFleet[0]?.runId || '');
    } catch (error) {
      setConnection('reconnecting');
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshRun = useCallback(async (owner: string): Promise<void> => {
    if (!LIVE || owner === '') return;
    try {
      const snapshot = await fetchRun(owner);
      setRun(snapshot);
      setConnection('live');
      cursorRef.current = Math.max(cursorRef.current, snapshot.asOfSequence);
      const page = await fetchEvents(owner, cursorRef.current);
      if (page.events.length > 0) {
        setEvents((current) => [...current, ...page.events].slice(-200));
      }
      cursorRef.current = page.nextCursor;
    } catch (error) {
      setConnection('reconnecting');
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshFleet();
    if (!LIVE) return undefined;
    const timer = window.setInterval(() => void refreshFleet(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshFleet]);

  useEffect(() => {
    setEvents([]);
    cursorRef.current = 0;
    if (!LIVE) {
      setRun(previewRun(selectedRunId || FIXTURE_SELECTED_RUN_ID));
      return undefined;
    }
    if (selectedRunId === '') {
      setRun(undefined);
      return undefined;
    }
    void refreshRun(selectedRunId);
    const timer = window.setInterval(() => void refreshRun(selectedRunId), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshRun, selectedRunId]);

  const railRuns = useMemo(() => fleet.map(toRailRun), [fleet]);
  const selectRun = (owner: string): void => {
    setSelectedRunId(owner);
    setScreen('overview');
  };
  const command = async (
    pathname: string,
    body: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    if (!LIVE) {
      setNotice('Preview mode is read-only. Start `harness serve` to drive real runs.');
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await postCommand(pathname, body);
      await refreshFleet();
      if (selectedRunId !== '') await refreshRun(selectedRunId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const startRun = async (body: Readonly<Record<string, unknown>>): Promise<void> => {
    if (!LIVE) {
      setNotice('Preview mode is read-only. Start `harness serve` to create a run.');
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await postCommand('/api/runs', body);
      const payload = result['payload'];
      const data =
        payload !== null && typeof payload === 'object' && 'data' in payload
          ? (payload as { data?: Readonly<Record<string, unknown>> }).data
          : undefined;
      const owner = typeof data?.['runId'] === 'string' ? data['runId'] : undefined;
      await refreshFleet();
      if (owner !== undefined) {
        setSelectedRunId(owner);
        setScreen('overview');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setScreen('fleet')}>
          <span className="brand__mark" aria-hidden="true">
            <i />
          </span>
          <span>Harness Control</span>
          <small>MVP</small>
        </button>
        <nav aria-label="Primary">
          {NAV.map((item) => (
            <button
              className={screen === item.id ? 'is-active' : ''}
              key={item.id}
              type="button"
              onClick={() => setScreen(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className={`connection connection--${connection}`}>
          <span aria-hidden="true" />
          {connection === 'live'
            ? `Local · v${meta?.version ?? '…'}`
            : connection === 'preview'
              ? 'Fixture preview'
              : 'Reconnecting'}
        </div>
      </header>
      {notice !== undefined ? (
        <div className="global-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <div className="app-body">
        <FleetRail
          runs={railRuns}
          selectedRunId={selectedRunId}
          onSelectRun={selectRun}
        />
        <div className="main-pane">
          {screen === 'fleet' ? (
            <Fleet runs={fleet} onSelect={selectRun} onNewRun={() => setScreen('new')} />
          ) : null}
          {screen === 'new' ? (
            <NewRun features={meta?.features} busy={busy} onSubmit={startRun} />
          ) : null}
          {screen === 'overview' ? (
            <Overview run={run} events={events} busy={busy} onCommand={command} />
          ) : null}
          {screen === 'assignment' ? (
            <AssignmentDetail
              run={run}
              features={meta?.features}
              busy={busy}
              onCommand={command}
            />
          ) : null}
          {screen === 'verification' ? <Verification run={run} /> : null}
        </div>
      </div>
    </div>
  );
}

function toRailRun(run: FleetRunWire): FleetRun {
  const group = groupFor(run.uiState);
  return {
    id: run.runId,
    goal: run.goal,
    phase: run.phase as RunPhase,
    suspension: run.suspension as SuspensionKind,
    operation: run.operation as OperationKind,
    group,
    glyph: glyphFor(run.uiState),
    fleetLabel: run.uiState.replaceAll('_', ' '),
    roleTag:
      run.activeImplementors > 0
        ? `${run.activeImplementors} Implementor${run.activeImplementors === 1 ? '' : 's'}`
        : run.phase.replaceAll('_', ' '),
  };
}

function groupFor(state: UiState): FleetGroupTitle {
  if (state === 'done' || state === 'handed_off') return 'Recently completed';
  if (state === 'paused_limit' || state === 'stopped') return 'Paused / recovering';
  if (state === 'waiting_on_you' || state === 'breaker_open') return 'Needs attention';
  return 'Active';
}

function glyphFor(state: UiState): string {
  if (state === 'done' || state === 'handed_off') return '✓';
  if (state === 'breaker_open') return '▲';
  if (state === 'paused_limit' || state === 'stopped') return '‖';
  if (state === 'working' || state === 'starting') return '●';
  return '◐';
}

function uiStateForFixture(run: FleetRun): UiState {
  if (run.suspension === 'breaker_open') return 'breaker_open';
  if (run.suspension === 'paused_limit') return 'paused_limit';
  if (run.phase === 'merge_ready') return 'done';
  if (run.phase === 'awaiting_approval' || run.group === 'Needs attention') {
    return 'waiting_on_you';
  }
  return run.phase === 'implementing' || run.phase === 'verifying' ? 'working' : 'idle';
}

function previewRun(owner: string): RunWire {
  const fleet = PREVIEW_FLEET.find((item) => item.runId === owner) ?? PREVIEW_FLEET[0]!;
  const isSelected = fleet.runId === FIXTURE_OVERVIEW.id;
  return {
    runId: fleet.runId,
    asOfSequence: 42,
    firstSeenAt: fleet.updatedAt,
    updatedAt: fleet.updatedAt,
    goal: fleet.goal,
    repositories: [
      {
        id: 'default',
        path: '/preview/harness-orchestration',
        baseCommit: 'c254435c254435c254435c254435c254435c2544',
      },
    ],
    phase: fleet.phase,
    suspension: fleet.suspension,
    suspensionDetail:
      fleet.suspension === 'paused_limit'
        ? 'Provider usage limit reached. Reset time unavailable.'
        : fleet.suspension === 'breaker_open'
          ? 'Recovery breaker is open after repeated failures.'
          : null,
    operation: fleet.operation,
    uiState: fleet.uiState,
    childActive: fleet.uiState === 'working',
    approval: {
      mode: 'auto',
      specVersionId: 'spec_preview_1',
      specHash: 'sha256:preview',
      approvedSpecHash: 'sha256:preview',
    },
    executionMode: 'in_place',
    spec: {
      canonicalSpec: '{}',
      tasks: [
        { id: 'T1', description: 'Add the CLI flag and thread it through parsing', dependsOn: [] },
        { id: 'T2', description: 'Gate diagnostic output and add coverage', dependsOn: ['T1'] },
      ],
      assignments: [],
    },
    assignments: [
      {
        id: 'cli-parser',
        repo: 'default',
        taskScope: 'Implement and test the --verbose parser surface.',
        writeScope: ['src/cli', 'src/cli/args.test.ts'],
        criteria: ['AC-1'],
        dependsOn: [],
        executionMode: 'in_place',
        implementor: { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
        stage: isSelected ? 'delivered' : 'running',
        round: 1,
      },
      {
        id: 'diagnostics',
        repo: 'default',
        taskScope: 'Wire verbose output and prove default silence.',
        writeScope: ['src/app'],
        criteria: ['AC-2'],
        dependsOn: ['cli-parser'],
        executionMode: 'in_place',
        implementor: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        stage: isSelected ? 'running' : 'pending',
        round: 1,
      },
    ],
    models: {
      coordinator: { effective: { harness: 'claude', model: 'opus', effort: 'low' } },
      implementor: {
        effective: { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
      },
      verifier: { effective: { harness: 'claude', model: 'sonnet', effort: 'medium' } },
    },
    cost: {
      measuredUsd: isSelected ? FIXTURE_OVERVIEW.costMeasured : 0.18,
      estimatedUsd: isSelected ? FIXTURE_OVERVIEW.costEstimated : 0.12,
      inputTokens: 28_420,
      outputTokens: 7_104,
      turns: 6,
    },
    verification: {
      criteria: [
        {
          id: 'AC-1',
          description: 'Parser recognizes --verbose without changing the default path',
          commands: ['npx vitest run src/cli/args.test.ts'],
          expectedEvidence: 'Targeted parser tests pass with host-attested exit 0.',
          verdict: 'passed',
          evidenceRefs: ['sha256:evidence-preview'],
          receipts: [
            {
              id: 'receipt-preview-1',
              command: '/bin/sh -c npx vitest run src/cli/args.test.ts',
              cwd: '/preview/harness-orchestration',
              exitCode: 0,
              launchFailed: false,
              receiptRef: 'sha256:receipt-preview',
            },
          ],
        },
        {
          id: 'AC-2',
          description: 'Default output remains silent',
          commands: [{ command: 'rg "debug:" output.txt', expectedExitCode: 1 }],
          expectedEvidence: 'Absence check exits 1 as declared.',
          verdict: fleet.phase === 'verifying' ? 'running' : 'pending',
          evidenceRefs: [],
          receipts: [],
        },
      ],
      remediationRounds: [],
    },
    eventCount: 42,
  };
}
