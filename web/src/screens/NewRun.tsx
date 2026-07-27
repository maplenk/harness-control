import { useState, type FormEvent } from 'react';
import type { MetaWire, RoleSpec } from '../client/types';
import { Badge, Card, ScreenHeader } from '../components/Ui';

interface RepoDraft {
  readonly key: number;
  readonly id: string;
  readonly path: string;
}

export function NewRun({
  features,
  busy,
  onSubmit,
}: {
  readonly features?: MetaWire['features'];
  readonly busy: boolean;
  readonly onSubmit: (body: Readonly<Record<string, unknown>>) => Promise<void>;
}) {
  const [goal, setGoal] = useState('');
  const [repos, setRepos] = useState<readonly RepoDraft[]>([
    { key: 1, id: 'default', path: '' },
  ]);
  const [coordinator, setCoordinator] = useState<RoleSpec>({
    harness: 'claude',
    model: 'opus',
    effort: 'high',
  });
  const [implementor, setImplementor] = useState<RoleSpec>({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  const [verifier, setVerifier] = useState<RoleSpec>({
    harness: 'claude',
    model: 'sonnet',
    effort: 'high',
  });
  const [executionMode, setExecutionMode] = useState<'in_place' | 'worktree'>('in_place');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await onSubmit({
      goal,
      repositories: repos.map(({ id, path }) => ({ id, path })),
      coordinator,
      implementor,
      verifier,
      executionMode,
    });
  };
  const updateRepo = (key: number, patch: Partial<RepoDraft>): void => {
    setRepos((current) =>
      current.map((repo) => (repo.key === key ? { ...repo, ...patch } : repo)),
    );
  };

  return (
    <main className="screen">
      <ScreenHeader
        eyebrow="Create"
        title="New run"
        detail="Pin the intent, repositories, role profiles and isolation policy before coordination starts."
        action={<Badge tone="neutral">Approval policy from config</Badge>}
      />
      <form className="form-layout" onSubmit={(event) => void submit(event)}>
        <Card title="Intent">
          <label className="field">
            <span>Goal</span>
            <textarea
              required
              rows={5}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Add a cross-cutting feature, verify it independently, and report the exact integration steps."
            />
          </label>
          <p className="field-help">
            The Coordinator turns this into an immutable, content-hashed spec. Approval follows
            the run&apos;s configured human or auto policy; the harness never merges or pushes.
          </p>
        </Card>

        <Card
          title="Repositories"
          action={
            <button
              className="button button--quiet"
              type="button"
              onClick={() =>
                setRepos((current) => [
                  ...current,
                  { key: Date.now(), id: `repo-${current.length + 1}`, path: '' },
                ])
              }
            >
              Add repository
            </button>
          }
        >
          <div className="repo-list">
            {repos.map((repo, index) => (
              <div className="repo-row" key={repo.key}>
                <label className="field">
                  <span>Name</span>
                  <input
                    required
                    value={repo.id}
                    onChange={(event) => updateRepo(repo.key, { id: event.target.value })}
                  />
                </label>
                <label className="field field--wide">
                  <span>Absolute path</span>
                  <input
                    required
                    className="mono"
                    value={repo.path}
                    onChange={(event) => updateRepo(repo.key, { path: event.target.value })}
                    placeholder="/path/to/repository"
                  />
                </label>
                {index > 0 ? (
                  <button
                    className="button button--danger button--icon"
                    type="button"
                    aria-label={`Remove ${repo.id}`}
                    onClick={() =>
                      setRepos((current) => current.filter((item) => item.key !== repo.key))
                    }
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {repos.length > 1 && features?.multiRepository !== true ? (
            <div className="notice notice--amber">
              The current engine exposes one repository per run. The server will refuse this
              multi-repository request instead of silently dropping a checkout.
            </div>
          ) : null}
        </Card>

        <Card title="Roles">
          <div className="role-profile-grid">
            <RoleProfile label="Coordinator" value={coordinator} onChange={setCoordinator} />
            <RoleProfile label="Implementor" value={implementor} onChange={setImplementor} />
            <RoleProfile label="Verifier" value={verifier} onChange={setVerifier} />
          </div>
          <p className="field-help">
            The Verifier must resolve to a different vendor from the Implementor; the host
            enforces that at dispatch.
          </p>
        </Card>

        <Card title="Execution">
          <div className="segmented" aria-label="Execution mode">
            {(['in_place', 'worktree'] as const).map((mode) => (
              <button
                className={executionMode === mode ? 'is-active' : ''}
                key={mode}
                type="button"
                onClick={() => setExecutionMode(mode)}
              >
                {mode === 'in_place' ? 'In place' : 'Worktree'}
                <small>
                  {mode === 'in_place'
                    ? 'Use the operator checkout'
                    : 'Create isolated assignment trees'}
                </small>
              </button>
            ))}
          </div>
          <div className="notice">
            This selection is applied when implementation starts. In-place work requires a
            clean checkout and never merges or pushes.
          </div>
        </Card>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || goal.trim() === '' || repos.some((repo) => repo.path.trim() === '')}
          >
            {busy ? 'Starting…' : 'Start coordination'}
          </button>
        </div>
      </form>
    </main>
  );
}

function RoleProfile({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: RoleSpec;
  readonly onChange: (value: RoleSpec) => void;
}) {
  return (
    <fieldset className="role-profile">
      <legend>{label}</legend>
      <label className="field">
        <span>Harness</span>
        <select
          value={value.harness}
          onChange={(event) =>
            onChange({ ...value, harness: event.target.value as RoleSpec['harness'] })
          }
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="grok">Grok Build</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>
      <label className="field">
        <span>Model</span>
        <input
          className="mono"
          value={value.model}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Effort</span>
        <select
          value={value.effort ?? ''}
          onChange={(event) =>
            onChange({
              ...value,
              ...(event.target.value !== '' ? { effort: event.target.value } : {}),
            })
          }
        >
          <option value="">Default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">X-high</option>
        </select>
      </label>
    </fieldset>
  );
}
