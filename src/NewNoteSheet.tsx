/**
 * The sheet for writing a new note on a picked element or drawing: type, text, target chain, draft saving and submit.
 */

'use client';

import React, { useContext, useEffect, useRef, useState } from 'react';
import { ChevronStartIcon } from './icons';
import { annotationErrorMessage } from './client';
import {
  ANNOTATION_TYPES,
  type AnnotateClient,
  type AnnotateHostContext,
  type AnnotationAnchor,
  type AnnotationDrawing,
  type AnnotationType,
  type CreatedAnnotation,
} from './types';
import Sheet, { SheetControlContext } from './Sheet';
import { buildAnchor, elementLabel } from './picker';
import { buildContext, roundRect, type PickSnapshot } from './context';
import { MAX_POINTS_TOTAL, MAX_STROKES } from './drawing';
import { clearDraft, hasDraft, loadDraft, saveDraft } from './draftStore';

const TEXT_MAX = 4000;

const TYPE_LABELS: Record<AnnotationType, string> = {
  bug: 'Bug',
  design: 'Design',
  content: 'Content',
  question: 'Question',
};

interface NewNoteSheetProps {
  client: AnnotateClient;
  /** Picked element first, then its `[data-ann]` ancestors. */
  chain: Element[];
  /** Index into `chain` of the highlighted element. */
  selected: number;
  onSelect: (index: number) => void;
  path: string;
  input: 'touch' | 'pointer';
  /** The screen when the element was picked; saved with the note. */
  snapshot: PickSnapshot;
  /** Marks relative to the selected element, when the note was drawn. */
  drawing?: AnnotationDrawing;
  /** Strokes left out to stay within the storage limits. */
  droppedStrokes?: number;
  /**
   * The marks relative to the picked element (`chain[0]`), kept with the
   * draft so they come back with its text. Must keep its identity between
   * renders while the marks are unchanged.
   */
  draftDrawing?: AnnotationDrawing;
  /** The picked element's anchor when the sheet opened; stored with the draft. */
  draftAnchor?: AnnotationAnchor;
  /** Read when the note is saved. */
  host: () => AnnotateHostContext;
  /** `draftKey` and `path` identify the sheet and page that started the save. */
  onSaved: (created: CreatedAnnotation, draftKey: string, path: string) => void;
  /** While true the layer blocks Escape and swipe-down. */
  onSavingChange?: (saving: boolean, draftKey: string) => void;
  /**
   * True when the admin discarded this element's draft after `since` (a
   * timestamp from when the save started). A failed save then leaves the
   * discard in place instead of restoring the text.
   */
  discardedSince?: (draftKey: string, since: number) => boolean;
  /**
   * A save failed after this sheet left the screen, so its own error line
   * cannot show. `draftKept` is true when the text went back into the draft
   * stored under `draftKey` for `path`.
   */
  onSaveFailedAway?: (message: string, draftKept: boolean, draftKey: string, path: string) => void;
  onClose: () => void;
  onTopChange?: (top: number) => void;
  /** Called with the draft text on open and on every edit. */
  onDraftChange?: (text: string) => void;
  /**
   * sessionStorage key for this element's unsaved draft. The draft is
   * restored on open, kept on every edit, and cleared by Save or a discard.
   */
  draftKey: string;
  /** The picked element's text when the sheet opened; a draft must match it. */
  draftSnippet: string;
}

/** Sheet for writing a note on the highlighted element. */
export default function NewNoteSheet({
  client,
  chain,
  selected,
  onSelect,
  path,
  input,
  snapshot,
  drawing,
  droppedStrokes = 0,
  draftDrawing,
  draftAnchor,
  host,
  onSaved,
  onClose,
  onTopChange,
  onDraftChange,
  onSavingChange,
  discardedSince,
  onSaveFailedAway,
  draftKey,
  draftSnippet,
}: NewNoteSheetProps) {
  const control = useContext(SheetControlContext);
  const [restored] = useState(() => loadDraft(draftKey, draftSnippet, chain[0]));
  const [type, setType] = useState<AnnotationType>(restored?.type ?? 'bug');
  const [text, setText] = useState(restored?.text ?? '');
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  // Write only once the admin has changed something: opening a sheet whose
  // stored draft belongs to another element must leave that draft alone.
  const initialRef = useRef({ text, type });
  const editedRef = useRef(false);
  useEffect(() => {
    // Fresh marks count as a change: they are kept even before any typing.
    if (
      !editedRef.current &&
      !draftDrawing &&
      text === initialRef.current.text &&
      type === initialRef.current.type
    ) {
      return;
    }
    editedRef.current = true;
    saveDraft(draftKey, {
      text,
      type,
      snippet: draftSnippet,
      ...(draftDrawing ? { drawing: draftDrawing } : {}),
      ...(draftAnchor ? { anchor: draftAnchor } : {}),
    });
  }, [draftKey, draftSnippet, text, type, draftDrawing, draftAnchor]);

  const mountedRef = useRef(true);
  const onSavingChangeRef = useRef(onSavingChange);
  const discardedSinceRef = useRef(discardedSince);
  const onSaveFailedAwayRef = useRef(onSaveFailedAway);
  useEffect(() => {
    onSavingChangeRef.current = onSavingChange;
    discardedSinceRef.current = discardedSince;
    onSaveFailedAwayRef.current = onSaveFailedAway;
  }, [onSavingChange, discardedSince, onSaveFailedAway]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Tell the layer about a restored draft so Escape asks before dropping it.
  useEffect(() => {
    if (restored?.text) onDraftChangeRef.current?.(restored.text);
  }, [restored]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A keyboard user is already typing; a finger pick should not throw the
  // keyboard over the page before the admin has looked at the highlight.
  useEffect(() => {
    if (input === 'pointer') textareaRef.current?.focus({ preventScroll: true });
  }, [input]);

  const target = chain[selected] ?? chain[0];
  const trimmed = text.trim();

  const save = async () => {
    if (!trimmed || saving || !target) return;
    setSaving(true);
    onSavingChangeRef.current?.(true, draftKey);
    setError(null);
    const startedAt = Date.now();
    // The draft leaves storage while the request is in flight, so nothing can
    // reopen and resubmit it; a failure puts it back.
    const key = draftKey;
    const pending = {
      text,
      type,
      snippet: draftSnippet,
      ...(draftDrawing ? { drawing: draftDrawing } : {}),
      ...(draftAnchor ? { anchor: draftAnchor } : {}),
    };
    clearDraft(key);
    try {
      const created = await client.create({
        text: trimmed,
        type,
        anchor: {
          // As picked; the live element may have changed while the admin typed.
          ...(snapshot.anchors[selected] ?? buildAnchor(target, path, window.location.href)),
          ...(snapshot.rects[selected] ? { rect: roundRect(snapshot.rects[selected]) } : {}),
          ...(drawing ? { drawing } : {}),
        },
        context: buildContext(snapshot, input, host()),
      });
      onSaved(created, key, path);
    } catch (err) {
      // Put the text back unless the admin discarded it meanwhile or has
      // started a newer draft on the same element.
      const restore = !discardedSinceRef.current?.(key, startedAt) && !hasDraft(key);
      if (restore) saveDraft(key, pending);
      if (!mountedRef.current) {
        onSaveFailedAwayRef.current?.(annotationErrorMessage(err), restore, key, path);
        return;
      }
      setError(annotationErrorMessage(err));
      setSaving(false);
      onSavingChangeRef.current?.(false, key);
    }
  };

  const title = (
    <div className="ann-chain" aria-label="Annotated element">
      {chain.map((el, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronStartIcon size={12} className="ann-chain-sep" />}
          <button
            type="button"
            className="ann-chip ann-chain-chip"
            aria-pressed={i === selected}
            disabled={saving}
            onClick={() => onSelect(i)}
          >
            {elementLabel(el)}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <Sheet
      label="New note"
      title={title}
      onClose={onClose}
      closeDisabled={saving}
      onTopChange={onTopChange}
    >
      {droppedStrokes > 0 && (
        <p className="ann-notice" role="status">
          {droppedStrokes === 1 ? '1 stroke was' : `${droppedStrokes} strokes were`} left out: a note keeps at
          most {MAX_STROKES} strokes and {MAX_POINTS_TOTAL.toLocaleString('en')} points.
        </p>
      )}
      <div className="ann-types" role="radiogroup" aria-label="Note type">
        {ANNOTATION_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            className="ann-chip"
            disabled={saving}
            onClick={() => setType(t)}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className="ann-textarea"
        aria-label="Note"
        placeholder="What should change here?"
        value={text}
        readOnly={saving}
        maxLength={TEXT_MAX}
        rows={4}
        dir="auto"
        onChange={(e) => {
          setText(e.target.value);
          onDraftChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error && (
        <p className="ann-error" role="alert">
          {error}
        </p>
      )}
      <div className="ann-actions">
        <button
          type="button"
          className="ann-btn"
          disabled={saving}
          onClick={() => {
            // Same as Escape: a draft with text or marks asks first.
            if (control) {
              control.requestDismiss();
              return;
            }
            clearDraft(draftKey);
            onClose();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ann-btn ann-btn-primary"
          onClick={() => void save()}
          disabled={!trimmed || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  );
}
