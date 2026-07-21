import { describe, expect, it } from 'vitest';
import { readStableHeadAndStatus } from './git.js';

describe('readStableHeadAndStatus', () => {
  it('C2: brackets porcelain status with HEAD reads and reports an in-check commit', async () => {
    const calls: string[] = [];
    const heads = ['a'.repeat(40), 'b'.repeat(40)];
    const snapshot = await readStableHeadAndStatus('/repo', {
      resolveSha: async (_dir, ref) => {
        calls.push(`head:${ref}`);
        return heads.shift()!;
      },
      statusPorcelain: async () => {
        calls.push('status');
        return '';
      },
    });

    expect(calls).toEqual(['head:HEAD', 'status', 'head:HEAD']);
    expect(snapshot).toMatchObject({
      headBefore: 'a'.repeat(40),
      headAfter: 'b'.repeat(40),
      statusPorcelain: '',
      stable: false,
    });
  });
});
