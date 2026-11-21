import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createLazyFixFast, type FixFastModule } from '../src/lazy';
import { FixFast } from '../src/FixFast';
import { hostContext } from './helpers';

describe('createLazyFixFast', () => {
  it('loads nothing and renders nothing while the viewer is not allowed', async () => {
    const load = vi.fn(async (): Promise<FixFastModule> => ({ FixFast }));
    const Lazy = createLazyFixFast(load);
    const { container } = render(<Lazy enabled={false} endpoint="/n" path="/" context={hostContext} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('[data-ann-ui]')).toBeNull();
  });

  it('loads the layer once it is enabled, and only once', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const load = vi.fn(async (): Promise<FixFastModule> => ({ FixFast }));
    const Lazy = createLazyFixFast(load);
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

  it('renders nothing and reports the error when the download fails, then retries on the next enable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi
      .fn<() => Promise<FixFastModule>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue({ FixFast });
    const Lazy = createLazyFixFast(load);
    const onError = vi.fn();
    const props = { endpoint: '/api/notes', path: '/', context: hostContext, onError };
    const { rerender } = render(
      <div>
        <p>host page</p>
        <Lazy enabled {...props} />
      </div>
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByText('host page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Annotations, / })).toBeNull();

    rerender(<div><p>host page</p><Lazy enabled={false} {...props} /></div>);
    rerender(<div><p>host page</p><Lazy enabled {...props} /></div>);
    expect(await screen.findByRole('button', { name: /^Annotations, / })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    silence.mockRestore();
    vi.unstubAllGlobals();
  });
});
