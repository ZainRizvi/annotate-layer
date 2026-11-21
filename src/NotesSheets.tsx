'use client';

import React, { useRef, useState } from 'react';
import { ExternalLinkIcon } from './icons';
import { annotationErrorMessage, isAnnotationGone } from './client';
import type { AnnotateClient, AnnotationItem, AnnotationStatus } from './types';
import Sheet from './Sheet';
import type { AnchorMap } from './useAnchoredNotes';

export const STATUS_LABELS: Record<AnnotationStatus, string> = {
  open: 'Open',
  working: 'Working',
  done: 'Done',
};

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0];
}

interface NoteDetailProps {
  client: AnnotateClient;
  note: AnnotationItem;
  moved: boolean;
  /** Skip the text when a row above already shows all of it. */
  hideText?: boolean;
  onShow?: () => void;
  /** A done note's pin is on the page: "Hide pin" removes it. */
  onHidePin?: () => void;
  onUpdated: (note: AnnotationItem) => void;
  /** The stored note no longer exists; the caller drops it and says so. */
  onGone: (note: AnnotationItem) => void;
}

/** A note's full text, status, link and the done/reopen action. */
export function NoteDetail({ client, note, moved, hideText, onShow, onHidePin, onUpdated, onGone }: NoteDetailProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextStatus = note.status === 'done' ? 'open' : 'done';

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await client.setStatus(note.number, nextStatus));
      setBusy(false);
    } catch (err) {
      if (isAnnotationGone(err)) {
        onGone(note);
        return;
      }
      setError(annotationErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="ann-detail">
      {!hideText && (
        <p className="ann-detail-text" dir="auto">
          {note.text}
        </p>
      )}
      <p className="ann-meta">
        <span className="ann-status-tag" data-status={note.status}>
          {STATUS_LABELS[note.status]}
        </span>
        <span>{note.type ?? 'untyped'}</span>
        <span>{note.author}</span>
        <span>{relativeTime(note.created_at)}</span>
        {moved && <span className="ann-moved">moved</span>}
      </p>
      {error && (
        <p className="ann-error" role="alert">
          {error}
        </p>
      )}
      <div className="ann-actions">
        <a className="ann-btn" href={note.html_url} target="_blank" rel="noreferrer">
          #{note.number} <ExternalLinkIcon size={14} />
        </a>
        {onShow && !moved && (
          <button type="button" className="ann-btn" onClick={onShow}>
            Show on page
          </button>
        )}
        {onHidePin && (
          <button type="button" className="ann-btn" onClick={onHidePin}>
            Hide pin
          </button>
        )}
        <button
          type="button"
          className="ann-btn ann-btn-primary"
          onClick={() => void toggle()}
          disabled={busy}
        >
          {note.status === 'done' ? 'Reopen' : 'Mark done'}
        </button>
      </div>
    </div>
  );
}

interface NoteSheetProps {
  client: AnnotateClient;
  note: AnnotationItem;
  moved: boolean;
  onHidePin?: () => void;
  onUpdated: (note: AnnotationItem) => void;
  onGone: (note: AnnotationItem) => void;
  onClose: () => void;
  onTopChange?: (top: number) => void;
}

/** Opened from a pin or "Show on page": one note. */
export function NoteSheet({ client, note, moved, onHidePin, onUpdated, onGone, onClose, onTopChange }: NoteSheetProps) {
  return (
    <Sheet
      label={`Note #${note.number}`}
      title={<span className="ann-sheet-heading">Note #{note.number}</span>}
      onClose={onClose}
      onTopChange={onTopChange}
    >
      <NoteDetail
        client={client}
        note={note}
        moved={moved}
        onHidePin={onHidePin}
        onUpdated={onUpdated}
        onGone={onGone}
      />
    </Sheet>
  );
}

interface NotesListSheetProps {
  client: AnnotateClient;
  notes: AnnotationItem[];
  anchors: AnchorMap;
  loading: boolean;
  error: string | null;
  onShow: (note: AnnotationItem) => void;
  onUpdated: (note: AnnotationItem) => void;
  onGone: (note: AnnotationItem) => void;
  onClose: () => void;
  /** Only these notes (one element's, from its "+N" pin), with a way back to all. */
  only?: number[];
  onShowAll?: () => void;
  /** Some done pins are on the page: "Hide done pins" removes them all. */
  onHideDonePins?: () => void;
}

/** Every note on this page (or on one element), one row each; a row expands in place. */
export function NotesListSheet({
  client,
  notes: allNotes,
  anchors,
  loading,
  error,
  onShow,
  onUpdated,
  onGone,
  onClose,
  only,
  onShowAll,
  onHideDonePins,
}: NotesListSheetProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  // The button goes away with the pins, so focus moves to the first row first.
  const hideDonePins = () => {
    listRef.current?.querySelector<HTMLElement>('.ann-row-head')?.focus();
    onHideDonePins?.();
    setAnnouncement('Done pins hidden');
  };
  const notes = only ? allNotes.filter((n) => only.includes(n.number)) : allNotes;
  const heading = only ? 'Notes on this element' : 'Notes on this page';

  return (
    <Sheet label={heading} title={<span className="ann-sheet-heading">{heading}</span>} onClose={onClose}>
      {only && onShowAll && (
        <button type="button" className="ann-btn ann-list-all" onClick={onShowAll}>
          All notes on this page
        </button>
      )}
      {onHideDonePins && (
        <button type="button" className="ann-btn ann-list-all" onClick={hideDonePins}>
          Hide done pins
        </button>
      )}
      <p className="ann-sr-only" role="status">
        {announcement}
      </p>
      {error && (
        <p className="ann-error" role="alert">
          {error}
        </p>
      )}
      {!error && loading && notes.length === 0 && <p className="ann-empty">Loading…</p>}
      {!error && !loading && notes.length === 0 && (
        <p className="ann-empty">No notes on this page yet. Long-press anything to add one.</p>
      )}
      <ul className="ann-list" ref={listRef}>
        {notes.map((note) => {
          const moved = !anchors.get(note.number);
          const open = expanded === note.number;
          return (
            <li key={note.number} className="ann-row" data-status={note.status}>
              <button
                type="button"
                className="ann-row-head"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : note.number)}
              >
                <span className="ann-row-title" dir="auto">
                  {firstLine(note.text)}
                </span>
                <span className="ann-meta">
                  <span>#{note.number}</span>
                  <span>{STATUS_LABELS[note.status]}</span>
                  {moved && <span className="ann-moved">moved</span>}
                </span>
              </button>
              {open && (
                <NoteDetail
                  client={client}
                  note={note}
                  moved={moved}
                  hideText={note.text.trim() === firstLine(note.text)}
                  onShow={() => onShow(note)}
                  onUpdated={onUpdated}
                  onGone={onGone}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
