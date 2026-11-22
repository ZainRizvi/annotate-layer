/**
 * The REST client for the annotations contract (docs/contract.md): builds the requests, reads
 * the replies into notes, and turns failures into `AnnotateError`s.
 */

import { fetchTransport, type FetchFunction } from './adapters/fetchTransport';
import {
  ANNOTATION_TYPES,
  type AnnotateClient,
  type AnnotationAnchor,
  type AnnotationItem,
  type AnnotationRect,
  type AnnotationStatus,
  type AnnotationType,
  type CreateAnnotationInput,
  type CreatedAnnotation,
} from './types';
import { isDrawing } from './drawing';

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
  fetch?: FetchFunction;
  /** Defaults to `include`, so cookie sessions work across origins. */
  credentials?: RequestCredentials;
  /**
   * Extra request headers, such as `Authorization: Bearer …` for a host that
   * authenticates with tokens. Called on every request, so a refreshed token
   * is picked up.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

/** `body[key]`, or undefined when `body` is not an object or lacks the key. */
function fieldOf(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? Object.entries(body).find(([name]) => name === key)?.[1]
    : undefined;
}

/** The response's `detail` as one line: a string, or the messages of a validation error list. */
function detailOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const detail = fieldOf(parsed, 'detail');
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d: unknown) => (typeof d === 'object' && d !== null && 'msg' in d ? String(d.msg) : ''))
        .filter(Boolean)
        .join('. ');
    }
    const message = fieldOf(parsed, 'message');
    if (typeof message === 'string') return message;
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

const STATUSES: readonly AnnotationStatus[] = ['open', 'working', 'done'];

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const statusOf = (value: unknown): AnnotationStatus | undefined => STATUSES.find((status) => status === value);
const typeOf = (value: unknown): AnnotationType | null => ANNOTATION_TYPES.find((type) => type === value) ?? null;

/** Marks an optional field that is present but has the wrong type. */
const wrongType = Symbol('wrongType');

/** What `read` makes of a present field; undefined for an absent or `null` one (the contract allows both). */
function optional<T>(value: unknown, read: (v: unknown) => T | undefined): T | undefined | typeof wrongType {
  if (value === undefined || value === null) return undefined;
  return read(value) ?? wrongType;
}

function rectOf(value: unknown): AnnotationRect | undefined {
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((key) => numberOf(fieldOf(value, key)));
  return x === undefined || y === undefined || w === undefined || h === undefined ? undefined : { x, y, w, h };
}

function stringsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((s: unknown) => typeof s === 'string') ? value.map(String) : undefined;
}

/**
 * The anchor stored with a note: `path`, `url` and `css_path` are required, the rest may be
 * absent or `null` (docs/contract.md) and is left out then. Undefined when a field has the wrong type.
 */
function anchorOf(value: unknown): AnnotationAnchor | undefined {
  const path = stringOf(fieldOf(value, 'path'));
  const url = stringOf(fieldOf(value, 'url'));
  const cssPath = stringOf(fieldOf(value, 'css_path'));
  const annId = optional(fieldOf(value, 'ann_id'), stringOf);
  const snippet = optional(fieldOf(value, 'text_snippet'), stringOf);
  const rect = optional(fieldOf(value, 'rect'), rectOf);
  const drawingField = fieldOf(value, 'drawing');
  const ancestorsField = fieldOf(value, 'ancestor_snippets');
  const ancestors = optional(ancestorsField, stringsOf);
  if (path === undefined || url === undefined || cssPath === undefined) return undefined;
  if (annId === wrongType || snippet === wrongType || rect === wrongType || ancestors === wrongType) return undefined;
  if (drawingField !== undefined && drawingField !== null && !isDrawing(drawingField)) return undefined;
  return {
    path,
    url,
    css_path: cssPath,
    ...(annId === undefined ? {} : { ann_id: annId }),
    ...(snippet === undefined ? {} : { text_snippet: snippet }),
    ...(ancestorsField === undefined ? {} : { ancestor_snippets: ancestors ?? null }),
    ...(rect === undefined ? {} : { rect }),
    ...(isDrawing(drawingField) ? { drawing: drawingField } : {}),
  };
}

/**
 * A note in the list-item shape (docs/contract.md), or undefined when a required field is
 * missing or mistyped: that is the mark of a page or proxy answering instead of the server.
 * `type` and `author` may be `null` there: an unknown type reads as no type, no author as ''.
 */
function noteOf(body: unknown): AnnotationItem | undefined {
  const number = numberOf(fieldOf(body, 'number'));
  const htmlUrl = stringOf(fieldOf(body, 'html_url'));
  const title = stringOf(fieldOf(body, 'title'));
  const text = stringOf(fieldOf(body, 'text'));
  const status = statusOf(fieldOf(body, 'status'));
  const anchor = anchorOf(fieldOf(body, 'anchor'));
  const createdAt = stringOf(fieldOf(body, 'created_at'));
  const updatedAt = stringOf(fieldOf(body, 'updated_at'));
  const closedAt = optional(fieldOf(body, 'closed_at'), stringOf);
  const author = optional(fieldOf(body, 'author'), stringOf);
  if (
    number === undefined ||
    htmlUrl === undefined ||
    title === undefined ||
    text === undefined ||
    status === undefined ||
    anchor === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    closedAt === wrongType ||
    author === wrongType
  ) {
    return undefined;
  }
  return {
    number,
    html_url: htmlUrl,
    title,
    text,
    type: typeOf(fieldOf(body, 'type')),
    status,
    anchor,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(closedAt === undefined ? {} : { closed_at: closedAt }),
    author: author ?? '',
  };
}

/** The reply to creating a note (docs/contract.md), or undefined when a field is missing or mistyped. */
function createdOf(body: unknown): CreatedAnnotation | undefined {
  const number = numberOf(fieldOf(body, 'number'));
  const htmlUrl = stringOf(fieldOf(body, 'html_url'));
  const status = statusOf(fieldOf(body, 'status'));
  const createdAt = stringOf(fieldOf(body, 'created_at'));
  return number === undefined || htmlUrl === undefined || status === undefined || createdAt === undefined
    ? undefined
    : { number, html_url: htmlUrl, status, created_at: createdAt };
}

/** The notes of a list reply, or undefined unless it has an `items` array of valid notes. */
function notesOf(body: unknown): AnnotationItem[] | undefined {
  const items = fieldOf(body, 'items');
  if (!Array.isArray(items)) return undefined;
  const notes = items.flatMap((item: unknown) => noteOf(item) ?? []);
  return notes.length === items.length ? notes : undefined;
}

/** What one call adds to the request: the method, body and its own headers. */
interface RequestSpec {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Client for the annotations REST contract (see README.md). */
export function createFetchClient({
  endpoint,
  fetch: fetchImpl,
  credentials = 'include',
  headers,
}: FetchClientOptions): AnnotateClient {
  const base = endpoint.replace(/\/+$/, '');

  const send = fetchImpl ?? fetchTransport;

  async function request(url: string, init: RequestSpec = {}): Promise<{ status: number; body: unknown }> {
    // A failing `headers()` is the host's error, not a network one: let it through.
    const extra = headers ? await headers() : {};
    let response: Response;
    try {
      response = await send(url, {
        ...init,
        headers: { ...extra, ...init.headers },
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
      const notes = notesOf(body);
      if (notes === undefined) throw unexpected('the list has no `items` of notes', status);
      return notes;
    },
    async create(payload: CreateAnnotationInput): Promise<CreatedAnnotation> {
      const { status, body } = await post(base, payload);
      const created = createdOf(body);
      if (created === undefined) {
        throw unexpected('the created note lacks the fields the contract requires (`number`, `html_url`, `status`, `created_at`); it may have been saved, so check the list before retrying', status);
      }
      return created;
    },
    async setStatus(number: number, status: 'open' | 'done'): Promise<AnnotationItem> {
      const { status: code, body } = await post(`${base}/${number}/status`, { status });
      const note = noteOf(body);
      if (note === undefined) throw unexpected('the updated note is not a note (it needs a `number` and the fields of a list item)', code);
      return note;
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
