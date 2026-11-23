import { describe, expect, it, vi } from 'vitest';
import { beginCapture } from '../src/captureHandle';
import type { CreatedAnnotation } from '../src/types';

const created: CreatedAnnotation = { number: 1, html_url: 'u', status: 'open', created_at: 't' };

describe('beginCapture', () => {
  it('is inert without a capture', async () => {
    const h = beginCapture(undefined);
    await h.commit(created);
    h.discard();
  });
  it('survives a begin that throws', async () => {
    const h = beginCapture({ begin: () => { throw new Error('x'); } });
    await expect(h.commit(created)).resolves.toBeUndefined();
  });
  it('settles once: commit then discard only commits', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    const h = beginCapture({ begin: () => ({ commit, discard }) });
    await h.commit(created);
    h.discard();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });
  it('swallows a rejected commit', async () => {
    const h = beginCapture({ begin: () => ({ commit: () => Promise.reject(new Error('x')), discard: () => undefined }) });
    await expect(h.commit(created)).resolves.toBeUndefined();
  });
});
