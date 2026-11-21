import React from 'react';
import { vi } from 'vitest';
import { FixFast } from '../src/FixFast';
import type { AnnotateHostContext } from '../src/types';

/** A client whose three calls are mocks; `list` resolves to no notes by default. */
export function fakeClient() {
  const client = { list: vi.fn(), create: vi.fn(), setStatus: vi.fn() };
  client.list.mockResolvedValue([]);
  return client;
}

export const hostContext = (): AnnotateHostContext => ({ theme: 'dark', lang: 'en', env: 'development' });

/** Renders the layer for `nav.path`, so `rerender(<Layer …/>)` after changing it navigates. */
export function makeLayer(client: ReturnType<typeof fakeClient>, nav: { path: string }) {
  return function Layer() {
    return <FixFast client={client} path={nav.path} context={hostContext} />;
  };
}
