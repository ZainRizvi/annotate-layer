import { describe, it, expect, vi } from 'vitest';
import { AnnotateError, annotationErrorMessage, createFetchClient, isAnnotationGone } from '../src/client';
import type { CreateAnnotationInput } from '../src/types';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

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
    fetchMock.mockResolvedValueOnce(jsonResponse({ number: 7 }));
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

describe('error helpers', () => {
  it('describes each kind in one line and recognises a gone note', () => {
    expect(isAnnotationGone(new AnnotateError('not_found', 'annotation_not_found', 404))).toBe(true);
    expect(isAnnotationGone(new Error('x'))).toBe(false);
    expect(annotationErrorMessage(new AnnotateError('http', 'nope', 403))).toMatch(/Sign in again/);
    expect(annotationErrorMessage(new Error('custom client broke'))).toBe('Annotations failed: custom client broke');
  });
});

describe('createFetchClient with a malformed success response', () => {
  const client = (body: string) =>
    createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => new Response(body, { status: 200 })) });

  it('reports a body that is not JSON as an AnnotateError, not a SyntaxError', async () => {
    const error = await client('<html>login</html>').list('/p', { fresh: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnnotateError);
    expect(annotationErrorMessage(error)).toContain('unexpected response');
  });

  it('reports a list reply without `items` as an AnnotateError', async () => {
    const error = await client('{}').list('/p', { fresh: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnnotateError);
  });
});

describe('createFetchClient with a reply that has no note', () => {
  it('rejects a create or status reply without a number', async () => {
    const client = createFetchClient({ endpoint: '/notes', fetch: vi.fn(async () => jsonResponse({ ok: true })) });
    await expect(client.create(input)).rejects.toBeInstanceOf(AnnotateError);
    await expect(client.setStatus(1, 'done')).rejects.toBeInstanceOf(AnnotateError);
  });
});
