import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createLazyAnnotateLayer, type AnnotateLayerModule } from '../src/lazy';
import { AnnotateLayer } from '../src/AnnotateLayer';
import { hostContext } from './helpers';

describe('createLazyAnnotateLayer', () => {
  it('loads nothing and renders nothing while the viewer is not allowed', async () => {
    const load = vi.fn(async (): Promise<AnnotateLayerModule> => ({ AnnotateLayer }));
    const Lazy = createLazyAnnotateLayer(load);
    const { container } = render(<Lazy enabled={false} endpoint="/n" path="/" context={hostContext} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('[data-ann-ui]')).toBeNull();
  });

  it('loads the layer once it is enabled, and only once', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const load = vi.fn(async (): Promise<AnnotateLayerModule> => ({ AnnotateLayer }));
    const Lazy = createLazyAnnotateLayer(load);
    const props = { endpoint: '/api/notes', path: '/', context: hostContext };
    const { rerender } = render(<Lazy enabled={false} {...props} />);
    rerender(<Lazy enabled {...props} />);
    expect(await screen.findByRole('button', { name: /^Annotations, / })).toBeInTheDocument();
    rerender(<Lazy enabled={false} {...props} />);
    rerender(<Lazy enabled {...props} />);
    await screen.findByRole('button', { name: /^Annotations, / });
    expect(load).toHaveBeenCalledTimes(1);
    // The `endpoint` prop builds a fetch client for it.
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/notes?path=%2F&state=all');
    vi.unstubAllGlobals();
  });
});
