import type {
  AnnotateClient,
  AnnotationItem,
  CreateAnnotationInput,
  CreatedAnnotation,
} from './types';

export type AnnotateErrorKind = 'not_configured' | 'not_found' | 'http' | 'network';

/**
 * A failed client call. `not_configured`: the server has no storage set up
 * (503 `annotations_not_configured`). `not_found`: the stored note is gone
 * (404 `annotation_not_found`). `http`: any other error response, with its
 * `status`. `network`: no response at all.
 */
export class AnnotateError extends Error {
  readonly kind: AnnotateErrorKind;
  readonly status?: number;

  constructor(kind: AnnotateErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AnnotateError';
    this.kind = kind;
    this.status = status;
  }
}

export interface FetchClientOptions {
  /**
   * URL of the host's annotations collection, such as
   * `https://api.example.com/api/admin/annotations` or a same-origin
   * `/api/admin/annotations`. The client sends `GET <endpoint>`,
   * `POST <endpoint>` and `POST <endpoint>/<number>/status`.
   */
  endpoint: string;
  fetch?: typeof fetch;
  /** Defaults to `include`, so cookie sessions work across origins. */
  credentials?: RequestCredentials;
  /**
   * Extra request headers, such as `Authorization: Bearer …` for a host that
   * authenticates with tokens. Called on every request, so a refreshed token
   * is picked up.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

/** The response's `detail` as one line: a string, or the messages of a validation error list. */
function detailOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
        .filter(Boolean)
        .join('. ');
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.trim().slice(0, 200);
}

function errorFor(status: number, body: string): AnnotateError {
  const detail = detailOf(body) || `HTTP ${status}`;
  if (status === 503 && detail === 'annotations_not_configured') {
    return new AnnotateError('not_configured', detail, status);
  }
  if (status === 404 && detail === 'annotation_not_found') {
    return new AnnotateError('not_found', detail, status);
  }
  return new AnnotateError('http', detail, status);
}

function unexpected(what: string, status: number): AnnotateError {
  return new AnnotateError('http', `unexpected response: ${what}`, status);
}

function hasNumber(body: unknown): body is { number: number } {
  return typeof body === 'object' && body !== null && 'number' in body && typeof body.number === 'number';
}

/**
 * Whether `body` identifies a note by its `number`. That is the only field checked: the rest of a
 * note's shape is the server's contract (docs/contract.md), and a reply without a number is the
 * mark of a page or proxy answering instead of the server.
 */
function isNote(body: unknown): body is AnnotationItem {
  return hasNumber(body);
}

function isCreated(body: unknown): body is CreatedAnnotation {
  return hasNumber(body);
}

function isItems(body: unknown): body is { items: AnnotationItem[] } {
  return typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items) && body.items.every(isNote);
}

/** Client for the annotations REST contract (see README.md). */
export function createFetchClient({
  endpoint,
  fetch: fetchImpl,
  credentials = 'include',
  headers,
}: FetchClientOptions): AnnotateClient {
  const base = endpoint.replace(/\/+$/, '');

  async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    // A failing `headers()` is the host's error, not a network one: let it through.
    const extra = headers ? await headers() : {};
    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)(url, {
        ...init,
        headers: { ...extra, ...(init.headers as Record<string, string> | undefined) },
        credentials,
      });
    } catch (err) {
      throw new AnnotateError('network', err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) throw errorFor(response.status, await response.text().catch(() => ''));
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      // A 200 that is not JSON is usually a login page the host redirected to.
      throw unexpected('the server did not return JSON', response.status);
    }
  }

  const post = (url: string, body: unknown) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    async list(path: string, { fresh }: { fresh: boolean }): Promise<AnnotationItem[]> {
      const qs = new URLSearchParams({ path, state: 'all' });
      if (fresh) qs.set('fresh', '1');
      const { status, body } = await request(`${base}?${qs.toString()}`);
      if (!isItems(body)) throw unexpected('the list has no `items` of notes', status);
      return body.items;
    },
    async create(payload: CreateAnnotationInput): Promise<CreatedAnnotation> {
      const { status, body } = await post(base, payload);
      if (!isCreated(body)) {
        throw unexpected('the created note has no `number`; it may have been saved, so check the list before retrying', status);
      }
      return body;
    },
    async setStatus(number: number, status: 'open' | 'done'): Promise<AnnotationItem> {
      const { status: code, body } = await post(`${base}/${number}/status`, { status });
      if (!isNote(body)) throw unexpected('the updated note has no `number`', code);
      return body;
    },
  };
}

/** True when the error says the stored note no longer exists. */
export function isAnnotationGone(error: unknown): boolean {
  return error instanceof AnnotateError && error.kind === 'not_found';
}

/** One-line, admin-facing explanation of a failed client call. */
export function annotationErrorMessage(error: unknown): string {
  if (!(error instanceof AnnotateError)) {
    // A host's own client may throw anything.
    return error instanceof Error && error.message
      ? `Annotations failed: ${error.message}`
      : 'Annotations failed. Try again.';
  }
  switch (error.kind) {
    case 'not_found':
      return 'This note no longer exists.';
    case 'not_configured':
      return 'Annotations are not set up on this server.';
    case 'network':
      return 'Could not reach the server. Check your connection and try again.';
    case 'http':
      if (error.status === 502) return `The notes store returned an error: ${error.message}. Try again.`;
      if (error.status === 401 || error.status === 403) {
        return 'Your session cannot write annotations. Sign in again as an admin.';
      }
      if (error.status === 422) return `The server rejected this note: ${error.message}`;
      return `Annotations failed (${error.status}): ${error.message}`;
  }
}
