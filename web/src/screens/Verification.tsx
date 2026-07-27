import type { CriterionWire, RunWire } from '../client/types';
import { Badge, Card, EmptyState, ScreenHeader } from '../components/Ui';

export function Verification({ run }: { readonly run?: RunWire }) {
  if (run === undefined) {
    return (
      <main className="screen">
        <EmptyState title="Select a run" detail="Verification evidence is scoped to one run." />
      </main>
    );
  }
  const readiness = run.verification.mergeReadiness;
  return (
    <main className="screen">
      <ScreenHeader
        eyebrow={`Independent verification · ${run.runId}`}
        title="Verification"
        detail="Criterion verdicts and exit codes come from host-attested execution, not model narration."
        action={
          readiness === undefined ? (
            <Badge tone="neutral">not evaluated</Badge>
          ) : (
            <Badge tone={readiness.ready ? 'green' : 'amber'}>
              {readiness.ready ? 'merge ready' : 'blocked'}
            </Badge>
          )
        }
      />
      <div className="criteria-list">
        {run.verification.criteria.length === 0 ? (
          <EmptyState
            title="No criteria yet"
            detail="The Coordinator’s acceptance criteria will appear after drafting."
          />
        ) : (
          run.verification.criteria.map((criterion) => (
            <CriterionCard criterion={criterion} key={criterion.id} />
          ))
        )}
      </div>
      {run.verification.latestFixRequest !== undefined ? (
        <Card title="Latest FixRequest" tone="amber">
          <pre className="code-block">{run.verification.latestFixRequest}</pre>
        </Card>
      ) : null}
      {readiness !== undefined ? (
        <Card title="Merge readiness" tone={readiness.ready ? 'green' : 'amber'}>
          <dl className="detail-grid detail-grid--wide">
            <dt>Verified commit</dt>
            <dd className="mono">{readiness.verifiedCommit}</dd>
            <dt>Base commit</dt>
            <dd className="mono">{readiness.baseCommit}</dd>
            <dt>Cross-vendor pair</dt>
            <dd>
              {readiness.resolvedHarnesses === undefined
                ? 'not recorded'
                : `${readiness.resolvedHarnesses.implementor} → ${readiness.resolvedHarnesses.verifier}`}
            </dd>
            <dt>Approval signer</dt>
            <dd>{readiness.specApprovedBy}</dd>
            <dt>Repository state</dt>
            <dd>
              destination {readiness.destinationClean ? 'clean' : 'dirty'} · worktree{' '}
              {readiness.worktreeClean ? 'clean' : 'dirty'} · base{' '}
              {readiness.baseDrifted ? 'drifted' : 'pinned'}
            </dd>
          </dl>
          {readiness.blockers.length > 0 ? (
            <ul className="blocker-list">
              {readiness.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          {readiness.manualIntegrationCommands.length > 0 ? (
            <>
              <h3>Manual integration commands</h3>
              <pre className="code-block">
                {readiness.manualIntegrationCommands.join('\n')}
              </pre>
            </>
          ) : null}
          {run.verification.subsetWarning !== undefined ? (
            <div className="notice notice--amber">
              <strong>Manual handoff only</strong>
              <span>{run.verification.subsetWarning}</span>
            </div>
          ) : null}
        </Card>
      ) : null}
    </main>
  );
}

function CriterionCard({ criterion }: { readonly criterion: CriterionWire }) {
  return (
    <Card
      title={`${criterion.id} · ${criterion.description}`}
      tone={criterion.verdict === 'failed' ? 'red' : criterion.verdict === 'passed' ? 'green' : 'default'}
      action={<Badge tone={verdictTone(criterion.verdict)}>{criterion.verdict}</Badge>}
    >
      <p className="expected-evidence">{criterion.expectedEvidence}</p>
      <div className="command-list">
        {criterion.commands.map((command, index) => {
          const text = typeof command === 'string' ? command : command.command;
          const expected = typeof command === 'string' ? 0 : (command.expectedExitCode ?? 0);
          return (
            <div className="command-row" key={`${text}-${index}`}>
              <code>{text}</code>
              <span>expected exit {expected}</span>
            </div>
          );
        })}
      </div>
      {criterion.receipts.map((receipt) => (
        <div className="receipt" key={receipt.id}>
          <div>
            <strong>Host receipt</strong>
            <code>{receipt.command}</code>
          </div>
          <Badge tone={receipt.exitCode === 0 && receipt.launchFailed !== true ? 'green' : 'red'}>
            exit {receipt.exitCode}
          </Badge>
        </div>
      ))}
      {criterion.note !== undefined ? <div className="notice">{criterion.note}</div> : null}
    </Card>
  );
}

function verdictTone(
  verdict: CriterionWire['verdict'],
): 'neutral' | 'accent' | 'amber' | 'green' | 'red' {
  if (verdict === 'passed') return 'green';
  if (verdict === 'failed') return 'red';
  if (verdict === 'unproven') return 'amber';
  if (verdict === 'running') return 'accent';
  return 'neutral';
}
