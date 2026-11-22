import { describe, it, expect, vi } from 'vitest';
import { AnnotateError, annotationErrorMessage, createFetchClient, isAnnotationGone } from '../src/client';
import type { CreateAnnotationInput } from '../src/types';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const note = {
  number: 7,
  html_url: 'https://github.com/example/site/issues/7',
  title: '[ann] Button text is cut off',
  text: 'Button text is cut off',
  type: 'bug',
  status: 'done',
  anchor: { path: '/pricing', url: 'https://example.com/pricing', css_path: 'main > button' },
  created_at: '2026-11-05T10:00:00Z',
  updated_at: '2026-11-06T10:00:00Z',
  closed_at: '2026-11-06T10:00:00Z',
  author: 'admin@example.com',
};

const input: CreateAnnotationInput = {
  text: 'Button text is cut off',
  type: 'bug',
  anchor: { path: '/pricing', url: 'https://example.com/pricing', css_path: 'main > button' },
  context: { viewport: { w: 390, h: 844, dpr: 3 }, input: 'touch', env: 'production' },
};

describe('createFetchClient', () => {
  it('sends the three calls to the configured endpoint, with cookies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = createFetchClient({ endpoint: 'https://api.example.com/feedback/notes/', fetch: fetchMock });

    await client.list('/pricing', { fresh: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ number: 7, html_url: 'h', status: 'open', created_at: 't' }, 201));
    await client.create(input);
    fetchMock.mockResolvedValueOnce(jsonResponse(note));
    await client.setStatus(7, 'done');

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [init.method ?? 'GET', url])).toEqual([
      ['GET', 'https://api.example.com/feedback/notes?path=%2Fpricing&state=all&fresh=1'],
      ['POST', 'https://api.example.com/feedback/notes'],
      ['POST', 'https://api.example.com/feedback/notes/7/status'],
    ]);
    expect(calls.every(([, init]) => init.credentials === 'include')).toBe(true);
    expect(JSON.parse(calls[1][1].body as string)).toEqual(input);
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ status: 'done' });
    expect((calls[1][1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('works with a same-origin path and adds host headers to every request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    let token = 'one';
    const client = createFetchClient({
      endpoint: '/api/admin/annotations',
      fetch: fetchMock,
      credentials: 'same-origin',
      headers: async () => ({ Authorization: `Bearer ${token}` }),
    });
    await client.list('/', { fresh: false });
    token = 'two';
    await client.list('/', { fresh: false });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe('/api/admin/annotations?path=%2F&state=all');
    expect(calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      'Bearer one',
      'Bearer two',
    ]);
    expect(calls[0][1].credentials).toBe('same-origin');
  });

  it('maps error responses to AnnotateError kinds', async () => {
    const cases: [Response, string, number | undefined][] = [
      [jsonResponse({ detail: 'annotations_not_configured' }, 503), 'not_configured', 503],
      [jsonResponse({ detail: 'annotation_not_found' }, 404), 'not_found', 404],
      [jsonResponse({ detail: [{ msg: 'text too long' }, { msg: 'bad type' }] }, 422), 'http', 422],
      [new Response('upstream down', { status: 502 }), 'http', 502],
      // Only the contract's own details map to their kinds.
      [jsonResponse({ detail: 'Not Found' }, 404), 'http', 404],
      [new Response('Service Unavailable', { status: 503 }), 'http', 503],
    ];
    for (const [response, kind, status] of cases) {
      const client = createFetchClient({ endpoint: '/n', fetch: async () => response });
      const error = await client.create(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnnotateError);
      expect((error as AnnotateError).kind).toBe(kind);
      expect((error as AnnotateError).status).toBe(status);
    }
    const validation = createFetchClient({
      endpoint: '/n',
      fetch: async () => jsonResponse({ detail: [{ msg: 'text too long' }, { msg: 'bad type' }] }, 422),
    });
    await expect(validation.create(input)).rejects.toThrow('text too long. bad type');
  });

  it('reports a request that never got a response as a network error', async () => {
    const client = createFetchClient({ endpoint: '/n', fetch: async () => Promise.reject(new TypeError('offline')) });
    const error = (await client.list('/', { fresh: false }).catch((e: unknown) => e)) as AnnotateError;
    expect(error.kind).toBe('network');
    expect(annotationErrorMessage(error)).toMatch(/Could not reach the server/);
  });
});

describe('createFetchClient replies', () => {
  const clientFor = (reply: unknown) =>
    createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => jsonResponse(reply)) });

  it('returns the server notes as sent, extra fields included', async () => {
    const withExtra = { ...note, labels: ['ui'], anchor: { ...note.anchor, extra: 1 } };
    const [item] = await clientFor({ items: [withExtra] }).list('/pricing', { fresh: false });
    expect(item).toEqual(withExtra);
    await expect(clientFor(withExtra).setStatus(7, 'done')).resolves.toEqual(withExtra);
  });

  it('passes null fields through unchanged', async () => {
    const wire = {
      ...note,
      type: null,
      closed_at: null,
      author: null,
      anchor: { ...note.anchor, ann_id: null, text_snippet: null, ancestor_snippets: null, rect: null, drawing: null },
    };
    const [item] = await clientFor({ items: [wire] }).list('/pricing', { fresh: false });
    expect(item).toEqual(wire);
  });

  it('accepts a note with type and author omitted, and one with status working', async () => {
    const bare = { ...note, type: undefined, author: undefined };
    const working = { ...note, number: 9, status: 'working' };
    await expect(clientFor({ items: [bare, working] }).list('/p', { fresh: false })).resolves.toEqual([bare, working]);
  });

  it('skips a malformed item and returns the others', async () => {
    const second = { ...note, number: 8 };
    const items = [note, { ...note, html_url: undefined }, null, { ...note, status: 'archived' }, second];
    await expect(clientFor({ items }).list('/p', { fresh: false })).resolves.toEqual([note, second]);
  });

  it('rejects a list reply whose items is not an array', async () => {
    await expect(clientFor({ items: {} }).list('/p', { fresh: false })).rejects.toBeInstanceOf(AnnotateError);
  });

  it('rejects an updated note missing required fields', async () => {
    await expect(clientFor({ ...note, anchor: undefined }).setStatus(7, 'done')).rejects.toBeInstanceOf(AnnotateError);
  });

  it('returns a created reply as sent and rejects one missing a field the contract requires', async () => {
    const created = { number: 7, html_url: 'h', status: 'open', created_at: 't', extra: true };
    await expect(clientFor(created).create(input)).resolves.toEqual(created);
    await expect(clientFor({ number: 7 }).create(input)).rejects.toBeInstanceOf(AnnotateError);
  });

  it('looks the global fetch up at call time', async () => {
    const client = createFetchClient({ endpoint: '/notes' });
    const later = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', later);
    try {
      await client.list('/p', { fresh: false });
      expect(later).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('error helpers', () => {
  it('describes each kind in one line and recognises a gone note', () => {
    expect(isAnnotationGone(new AnnotateError('not_found', 'annotation_not_found', 404))).toBe(true);
    expect(isAnnotationGone(new Error('x'))).toBe(false);
    expect(annotationErrorMessage(new AnnotateError('http', 'nope', 403))).toMatch(/Sign in again/);
    expect(annotationErrorMessage(new Error('custom client broke'))).toBe('Annotations failed: custom client broke');
  });
});

describe('createFetchClient with a malformed success reply', () => {
  type Client = ReturnType<typeof createFetchClient>;
  const calls: Array<[string, (c: Client) => Promise<unknown>]> = [
    ['list', (c) => c.list('/p', { fresh: false })],
    ['create', (c) => c.create(input)],
    ['setStatus', (c) => c.setStatus(7, 'done')],
  ];
  const replies: Array<[string, string]> = [
    ['not JSON', '<html>login</html>'],
    ['an empty object', '{}'],
    ['null', 'null'],
    ['an array', '[]'],
  ];

  it.each(calls.flatMap(([name, call]) => replies.map(([label, body]) => [name, label, call, body] as const)))(
    '%s rejects %s with an http AnnotateError that names the status',
    async (_name, _label, call, body) => {
      const client = createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => new Response(body, { status: 200 })) });
      const error = await call(client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnnotateError);
      expect((error as AnnotateError).kind).toBe('http');
      expect(annotationErrorMessage(error)).toMatch(/^Annotations failed \(200\): unexpected response: /);
    }
  );

  it('lists no notes when every item is malformed', async () => {
    for (const items of [[null], [{}]]) {
      const client = createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => jsonResponse({ items })) });
      await expect(client.list('/p', { fresh: false })).resolves.toEqual([]);
    }
  });

  it('tells the admin a create may have been saved', async () => {
    const client = createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => jsonResponse({ ok: true })) });
    const error = await client.create(input).catch((e: unknown) => e);
    expect(annotationErrorMessage(error)).toContain('may have been saved');
  });
});

describe('createFetchClient with non-object replies', () => {
  it.each(['5', '"text"', 'true', 'null'])('rejects the reply %s without throwing a TypeError', async (body) => {
    const client = createFetchClient({ endpoint: '/n', fetch: async () => new Response(body, { status: 200 }) });
    await expect(client.list('/p', { fresh: false })).rejects.toBeInstanceOf(AnnotateError);
  });
});
