/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  FIXTURE_GROUPS,
  FIXTURE_RUNS,
  FIXTURE_SELECTED_RUN_ID,
} from '../fixtures/runs';
import { FleetRail } from './FleetRail';

afterEach(() => {
  cleanup();
});

describe('FleetRail', () => {
  it('renders one fleet-rail row for every fixture run', () => {
    render(
      <FleetRail runs={FIXTURE_RUNS} selectedRunId={FIXTURE_SELECTED_RUN_ID} />,
    );

    for (const run of FIXTURE_RUNS) {
      const row = screen.getByTestId(`fleet-row-${run.id}`);
      expect(row).toBeTruthy();
      expect(row.textContent).toContain(run.goal);
      expect(row.textContent).toContain(run.fleetLabel);
      expect(row.textContent).toContain(run.roleTag);
    }

    const rows = screen.getAllByTestId(/^fleet-row-/);
    expect(rows).toHaveLength(FIXTURE_RUNS.length);
  });

  it('renders a heading for every non-empty fleet-rail group', () => {
    render(
      <FleetRail runs={FIXTURE_RUNS} selectedRunId={FIXTURE_SELECTED_RUN_ID} />,
    );

    const nonEmpty = FIXTURE_GROUPS.filter((title) =>
      FIXTURE_RUNS.some((run) => run.group === title),
    );
    expect(nonEmpty.length).toBeGreaterThan(0);

    for (const title of nonEmpty) {
      const heading = screen.getByRole('heading', { name: title, level: 2 });
      expect(heading).toBeTruthy();
      expect(heading.textContent).toBe(title);
    }

    const empty = FIXTURE_GROUPS.filter(
      (title) => !FIXTURE_RUNS.some((run) => run.group === title),
    );
    for (const title of empty) {
      expect(screen.queryByRole('heading', { name: title, level: 2 })).toBeNull();
    }
  });

  it('marks exactly one fleet-rail row as selected', () => {
    render(
      <FleetRail runs={FIXTURE_RUNS} selectedRunId={FIXTURE_SELECTED_RUN_ID} />,
    );

    const selected = screen
      .getAllByTestId(/^fleet-row-/)
      .filter((row) => row.getAttribute('aria-current') === 'true');
    expect(selected).toHaveLength(1);

    const selectedRow = selected[0]!;
    expect(selectedRow.getAttribute('data-run-id')).toBe(FIXTURE_SELECTED_RUN_ID);
    expect(
      within(selectedRow).getByText(
        FIXTURE_RUNS.find((r) => r.id === FIXTURE_SELECTED_RUN_ID)!.goal,
      ),
    ).toBeTruthy();
  });
});
