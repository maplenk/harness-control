/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from './App';

afterEach(() => cleanup());

describe('Harness Control MVP shell', () => {
  it('exposes the five focused screens and keeps preview mode honest', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Fleet', 'New run', 'Overview', 'Assignment', 'Verification']) {
      expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByText('Fixture preview')).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: 'Overview' }));
    expect(screen.getByRole('heading', { name: 'Coordinator plan' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Assignment board/ })).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: 'Assignment' }));
    expect(screen.getByRole('heading', { name: 'Assignment detail' })).toBeTruthy();
    expect(screen.getByText('Switch at next boundary')).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: 'Verification' }));
    expect(screen.getByRole('heading', { name: 'Verification' })).toBeTruthy();
    expect(screen.getByText('Host receipt')).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: 'New run' }));
    expect(screen.getByRole('heading', { name: 'New run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy();
  });
});
