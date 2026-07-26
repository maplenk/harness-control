/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FIXTURE_OVERVIEW } from '../fixtures/runs';
import { RunOverview } from './RunOverview';

afterEach(() => {
  cleanup();
});

describe('RunOverview', () => {
  it('renders the selected run goal, id and phase label', () => {
    render(<RunOverview overview={FIXTURE_OVERVIEW} />);

    expect(
      screen.getByRole('heading', { name: FIXTURE_OVERVIEW.goal, level: 1 }),
    ).toBeTruthy();
    expect(screen.getByTestId('run-id').textContent).toBe(FIXTURE_OVERVIEW.id);
    expect(screen.getByTestId('phase-label').textContent).toBe(
      FIXTURE_OVERVIEW.phaseLabel,
    );
  });

  it('renders the three role lanes with harness, model and effort', () => {
    render(<RunOverview overview={FIXTURE_OVERVIEW} />);

    expect(FIXTURE_OVERVIEW.roleLanes).toHaveLength(3);

    for (const lane of FIXTURE_OVERVIEW.roleLanes) {
      const card = screen.getByTestId(`role-lane-${lane.role}`);
      expect(within(card).getByRole('heading', { name: lane.role })).toBeTruthy();
      expect(card.textContent).toContain(lane.harness);
      expect(card.textContent).toContain(lane.model);
      expect(card.textContent).toContain(lane.effort);
    }
  });

  it('renders the five workflow nodes in order', () => {
    render(<RunOverview overview={FIXTURE_OVERVIEW} />);

    expect(FIXTURE_OVERVIEW.workflowNodes).toHaveLength(5);

    const rail = screen.getByTestId('workflow-rail');
    const nodes = within(rail).getAllByTestId(/^workflow-node-/);
    expect(nodes).toHaveLength(FIXTURE_OVERVIEW.workflowNodes.length);

    // node text includes glyph + label; assert labels appear in order in rail text
    let cursor = 0;
    const railText = rail.textContent ?? '';
    for (const expected of FIXTURE_OVERVIEW.workflowNodes) {
      const idx = railText.indexOf(expected, cursor);
      expect(idx).toBeGreaterThanOrEqual(0);
      cursor = idx + expected.length;
      expect(screen.getByTestId(`workflow-node-${expected}`)).toBeTruthy();
    }
  });

  it('renders the measured and estimated cost split', () => {
    render(<RunOverview overview={FIXTURE_OVERVIEW} />);

    const cost = screen.getByTestId('cost-split');
    const measured = FIXTURE_OVERVIEW.costMeasured.toFixed(2);
    const estimated = FIXTURE_OVERVIEW.costEstimated.toFixed(2);

    expect(cost.textContent).toContain(`$${measured}`);
    expect(cost.textContent).toMatch(/measured/i);
    expect(cost.textContent).toContain(`$${estimated}`);
    expect(cost.textContent).toMatch(/est/i);
  });
});
