/** Data shapes shared by the layer, its client and the REST contract. */

export const ANNOTATION_TYPES = ['bug', 'design', 'content', 'question'] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

export type AnnotationStatus = 'open' | 'working' | 'done';

/** `{x, y, w, h}` in CSS pixels (or, inside a drawing, element-relative units). */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pen stroke: `[x, y]` points, relative to the anchor element's rect (0..1 is inside it). */
export type AnnotationStroke = Array<[number, number]>;

export interface AnnotationDrawing {
  strokes: AnnotationStroke[];
  /** Bounding box of all strokes, in the same element-relative units. */
  bbox: AnnotationRect;
}

export interface AnnotationAnchor {
  /** The page key the note belongs to, e.g. `/products/8f2e41`. */
  path: string;
  url: string;
  ann_id?: string;
  css_path: string;
  /** At most 200 characters. */
  text_snippet?: string;
  /**
   * Text of the element's `[data-ann]` ancestors, innermost first (at most 6,
   * each at most 200 characters). Tells apart repeats whose own text is
   * identical, such as every card's action row. `null` from the server
   * for notes saved without it.
   */
  ancestor_snippets?: string[] | null;
  /** The element's viewport rect when it was picked. */
  rect?: AnnotationRect;
  drawing?: AnnotationDrawing;
}

export interface AnnotationContext {
  viewport: { w: number; h: number; dpr: number };
  /** Window scroll offset when the element was picked. */
  scroll?: { x: number; y: number };
  input: 'touch' | 'pointer';
  env: string;
  build_sha?: string;
  theme?: string;
  lang?: string;
  ua?: string;
}

export interface CreateAnnotationInput {
  text: string;
  type: AnnotationType;
  anchor: AnnotationAnchor;
  context: AnnotationContext;
}

export interface CreatedAnnotation {
  number: number;
  html_url: string;
  status: AnnotationStatus;
  created_at: string;
}

export interface AnnotationItem {
  number: number;
  html_url: string;
  title: string;
  text: string;
  /** `null` for a note stored without a type. */
  type: AnnotationType | null;
  status: AnnotationStatus;
  anchor: AnnotationAnchor;
  created_at: string;
  updated_at: string;
  /** When a done note was closed; `null` or absent otherwise. */
  closed_at?: string | null;
  author: string;
}

/** Where the layer reads and writes notes. `createFetchClient` implements the REST contract. */
export interface AnnotateClient {
  /** Notes for one page key, including recently closed ones. `fresh` skips any server cache. */
  list(path: string, options: { fresh: boolean }): Promise<AnnotationItem[]>;
  create(payload: CreateAnnotationInput): Promise<CreatedAnnotation>;
  setStatus(number: number, status: 'open' | 'done'): Promise<AnnotationItem>;
}

/** What the host knows about the page that the layer cannot read from the DOM. */
export interface AnnotateHostContext {
  theme: 'dark' | 'light';
  lang: string;
  /** E.g. `production`, `preview`, `development`. */
  env: string;
  buildSha?: string;
}

/** The long-press toggle, kept by the host. */
export interface AnnotateLongPress {
  enabled: boolean;
  onChange(enabled: boolean): void;
}

/** Key-value store for done-pin views and hides (`ann:done-pins`, JSON), kept per viewer. */
export interface AnnotateStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Held by the layer from the moment an element is picked until its note is saved or dropped. */
export interface CaptureHandle {
  /** The note was saved; settle whatever `begin` started. */
  commit(created: CreatedAnnotation): Promise<void>;
  /** The draft was dropped; release whatever `begin` started. */
  discard(): void;
}

/** An optional extra recorded for each note, such as a screenshot of the picked view. */
export interface NoteCapture {
  /** Called at pick time, before the sheet opens. Must not throw. */
  begin(): CaptureHandle;
}
