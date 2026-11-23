/**
 * The FixFast annotation layer: the pin button and its menu, pick and draw modes, pins on the page, and the new-note and notes sheets.
 */

'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CrosshairIcon, HandIcon, ListIcon, NotePlusIcon, PenIcon } from './icons';
import { annotationErrorMessage, createFetchClient } from './client';
import type {
  AnnotateClient,
  AnnotateHostContext,
  AnnotateLongPress,
  AnnotateStorage,
  AnnotationItem,
  CaptureHandle,
  CreatedAnnotation,
  NoteCapture,
} from './types';
import { annChain, LAYER_UI_ATTR, pageElementAt, resolvePickTarget, textSnippet } from './picker';
import { useLongPress, type StrokeSink } from './useLongPress';
import { snapshotPick, type PickSnapshot } from './context';
import { beginCapture } from './captureHandle';
import {
  drawingToPixels,
  isDrawing,
  limitStrokes,
  normalizeDrawing,
  rectOf,
  reprojectStrokes,
  simplifyStroke,
  strokesBounds,
  type PixelStroke,
} from './drawing';
import DrawMode from './DrawMode';
import PinMenu, { type MenuFocus } from './PinMenu';
import Marks from './Marks';
import { useModifierPick, useTapToPick } from './usePickModes';
import { useAnchoredNotes } from './useAnchoredNotes';
import { useDonePins } from './useDonePins';
import { defaultStorage, donePinKey } from './donePins';
import { prefersReducedMotion, useViewportFrame } from './useViewportFrame';
import { useLayerEscape } from './useLayerEscape';
import { clearDraft, resolveDraft } from './draftStore';
import { SheetControlContext, type SheetControl } from './Sheet';
import NewNoteSheet from './NewNoteSheet';
import { NoteSheet, NotesListSheet } from './NotesSheets';
import Pins from './Pins';

/** Where notes are read and written: a REST endpoint, or a client of the host's own. */
export type FixFastSource =
  | {
      /**
       * URL of the host's annotations collection (see the REST contract). The
       * layer talks to it with `createFetchClient({ endpoint })`: cookies are
       * sent, no extra headers. Pass `client` instead for anything else.
       */
      endpoint: string;
      client?: never;
    }
  | { client: AnnotateClient; endpoint?: never };

export type FixFastProps = FixFastSource & FixFastOptions;

export interface FixFastOptions {
  /** The page key notes are grouped by; changing it reloads the notes. */
  path: string;
  /** Theme, language, environment and build of the host page. Called on render and on save. */
  context: () => AnnotateHostContext;
  /**
   * The long-press toggle, when the host keeps it (for example on the
   * reviewer's account). Without it the toggle starts on and lasts for the
   * page view.
   */
  longPress?: AnnotateLongPress;
  /** Where done-pin views and hides are kept. Defaults to localStorage. */
  storage?: AnnotateStorage;
  /** Recorded alongside each note: begun at pick time, committed once the note is saved. */
  capture?: NoteCapture;
}
const FLASH_MS = 1400;
const TOAST_MS = 5000;
const ERROR_TOAST_MS = 10000;
/** Gap kept between the pin button and a composer docked at the bottom. */
const COMPOSER_GAP = 12;
/** A sheet top rising by more than this means the keyboard opened. */
const KEYBOARD_RISE_PX = 40;
const KEYBOARD_REVEAL_DEBOUNCE_MS = 150;
const FAB_DEFAULT_BOTTOM = 'calc(16px + env(safe-area-inset-bottom, 0px))';

interface Toast {
  text: string;
  link?: { href: string; label: string };
  /** Announced as an alert rather than a status, and shown for longer. */
  error?: boolean;
}

type SheetState =
  | {
      kind: 'new';
      /** Unique per opening: a save that finishes later closes only its own sheet. */
      openId: number;
      chain: Element[];
      selected: number;
      input: 'touch' | 'pointer';
      /** Fixed when the sheet opens; later DOM changes must not move the draft. */
      draftKey: string;
      /** The picked element's text at open; a stored draft must match it. */
      draftSnippet: string;
      snapshot: PickSnapshot;
      /** Begun at pick time; settles at most once, by commit or discard. */
      capture: CaptureHandle;
      /** Marks drawn before the pick, in viewport pixels at pick time. */
      strokes?: PixelStroke[];
      /** Strokes left out to stay within the storage limits. */
      droppedStrokes?: number;
    }
  | { kind: 'note'; number: number }
  /** `numbers`: only one element's notes, opened from its "+N" pin. */
  | { kind: 'list'; numbers?: number[] }
  | null;

/** Releases a new-note sheet's capture; a no-op when it already settled. */
function discardPendingCapture(sheet: SheetState): void {
  if (sheet?.kind === 'new') sheet.capture.discard();
}

function rectStyle(el: Element | null): React.CSSProperties | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 };
}

/** Whether `el` carries an inline `style` (HTML and SVG elements do, whichever window they came from). */
function hasInlineStyle(el: Element): el is Element & ElementCSSInlineStyle {
  return 'style' in el && typeof el.style === 'object' && el.style !== null && 'setProperty' in el.style;
}

/** Bring `el` into the part of the screen above the sheet. */
function revealAbove(el: Element, sheetTop: number) {
  const r = el.getBoundingClientRect();
  const topLimit = 72;
  if (r.top >= topLimit && r.top < sheetTop - 48) return;
  const styled = hasInlineStyle(el) ? el : null;
  const previous = styled?.style.scrollMarginTop ?? '';
  if (styled) styled.style.scrollMarginTop = `${topLimit}px`;
  el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (styled) styled.style.scrollMarginTop = previous;
}

/** Draw mode: finished strokes and the one in progress, in viewport pixels. */
interface DrawState {
  strokes: PixelStroke[];
  live: PixelStroke | null;
  input: 'touch' | 'pointer';
  /** Opened from the pin menu rather than by a gesture. */
  fromMenu?: boolean;
}

/** The element under the centre of the strokes, skipping the layer's own UI. */
function elementUnderStrokes(strokes: PixelStroke[]): Element {
  const box = strokesBounds(strokes);
  if (!box) return document.body;
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  return pageElementAt(x, y) ?? document.body;
}

/** Bottom offset that keeps the pin button above a `[data-ann-dock]` bar docked at the bottom. */
function pinButtonBottom(): string {
  const docked = Array.from(document.querySelectorAll('[data-ann-dock]'));
  for (const composer of docked) {
    const r = composer.getBoundingClientRect();
    if (r.height > 0 && r.top > window.innerHeight * 0.5 && r.top < window.innerHeight) {
      return `${Math.round(window.innerHeight - r.top + COMPOSER_GAP)}px`;
    }
  }
  return FAB_DEFAULT_BOTTOM;
}

/**
 * Annotation layer: pin button, long-press / tap-to-pick / ⌘-click picking,
 * note sheets and pins. The host decides who sees it; the layer renders for
 * whoever it is mounted for.
 */
export function FixFast({
  client: hostClient,
  endpoint,
  path,
  context,
  longPress,
  storage = defaultStorage,
  capture,
}: FixFastProps) {
  const client = useMemo(
    () => hostClient ?? createFetchClient({ endpoint }),
    [hostClient, endpoint]
  );
  const { theme } = context();
  const clientRef = useRef(client);
  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const captureRef = useRef(capture);
  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [notes, setNotes] = useState<AnnotationItem[]>([]);
  /** The page `notes` were loaded for; pins count as seen only on that page. */
  const [notesPath, setNotesPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Where focus goes when the menu opens; see PinMenu. */
  const [menuFocus, setMenuFocus] = useState<MenuFocus>('menu');
  const menuId = useId();
  const fabRef = useRef<HTMLButtonElement>(null);
  /** Bumped to move focus to the pin button once it is on screen. */
  const [fabFocusRequest, setFabFocusRequest] = useState(0);
  /** Draw mode was opened from the menu, so focus returns to the pin button after. */
  const drawFromMenuRef = useRef(false);
  const [armed, setArmed] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [hovered, setHovered] = useState<Element | null>(null);
  /** A long-press fired and the finger is still down on this element. */
  const [pressed, setPressed] = useState<Element | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  /** An element to bring above the note sheet once that sheet has measured itself. */
  const [reveal, setReveal] = useState<Element | null>(null);
  const [flash, setFlash] = useState<Element | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  /** An error toast stays until it times out or a newer error replaces it. */
  const showToast = useCallback((next: Toast) => {
    setToast((shown) => (shown?.error && !next.error ? shown : next));
  }, []);
  const [ownLongPressOn, setOwnLongPressOn] = useState(true);
  const longPressOn = longPress ? longPress.enabled : ownLongPressOn;
  const [draft, setDraft] = useState('');
  const [discardPrompt, setDiscardPrompt] = useState(false);
  /** A new note's create request is in flight. */
  const [saving, setSaving] = useState(false);
  const [fabBottom, setFabBottom] = useState(FAB_DEFAULT_BOTTOM);
  const sheetTopRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
  /** Last top the open sheet reported; null until the current sheet reports. */
  const lastSheetTopRef = useRef<number | null>(null);
  const revealTimerRef = useRef(0);
  const requestIdRef = useRef(0);
  /** When each element's draft was last discarded, by draft key. */
  const discardedAtRef = useRef(new Map<string, number>());
  /** The page on screen now; writes that finish later compare against it. */
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  /**
   * Load the notes of the page on screen (read from `pathRef`, so a caller
   * from an older render cannot load another page's notes). Only the newest
   * request may write state. `fresh` skips the server cache after a write.
   */
  const refresh = useCallback(
    async (fresh = false) => {
      const id = ++requestIdRef.current;
      const requested = pathRef.current;
      setLoading(true);
      try {
        const items = await clientRef.current.list(requested, { fresh });
        if (id !== requestIdRef.current) return;
        setNotes(items);
        setNotesPath(requested);
        setLoadError(null);
      } catch (err) {
        if (id !== requestIdRef.current) return;
        setLoadError(annotationErrorMessage(err));
      } finally {
        if (id === requestIdRef.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    setNotes([]);
    void refresh();
  }, [path, refresh]);

  /**
   * After a write, reload with `fresh` so the list shows it, unless the admin
   * has moved to another page since `startedOn`: that page's notes stay as
   * they are.
   */
  const refreshAfterWrite = useCallback(
    (startedOn: string) => {
      if (startedOn === pathRef.current) void refresh(true);
    },
    [refresh]
  );

  const anchors = useAnchoredNotes(notes);
  const donePins = useDonePins(storage, path);
  const pinNotes = useMemo(() => notes.filter(donePins.showsPin), [notes, donePins.showsPin]);
  /** Done notes found on this page whose pins still show, for "Hide pin" and "Hide done pins". */
  const shownDone = useMemo(
    () => pinNotes.filter((n) => donePinKey(n) !== null && anchors.get(n.number)),
    [pinNotes, anchors]
  );
  const highlighted = sheet?.kind === 'new' ? sheet.chain[sheet.selected] : null;
  const drawing = draw !== null;
  // The element a pin belongs to stays outlined while its note is open.
  const noteTarget = sheet?.kind === 'note' ? anchors.get(sheet.number) ?? null : null;
  const hasPins = useMemo(() => pinNotes.some((n) => anchors.get(n.number)), [pinNotes, anchors]);
  const sheetNote = sheet?.kind === 'note' ? notes.find((n) => n.number === sheet.number) : undefined;
  // Only a sheet that is actually on screen counts: a note sheet whose note
  // has left the list renders nothing and must not hold Escape or block picks.
  const sheetOpen = sheet?.kind === 'new' || sheet?.kind === 'list' || !!sheetNote;
  const newNoteDraftKey = sheet?.kind === 'new' ? sheet.draftKey : null;
  // Marks relative to the picked element, stored with the draft. Memoized so
  // the sheet writes the draft only when the marks or the text change.
  const draftDrawing = useMemo(
    () =>
      sheet?.kind === 'new' && sheet.strokes?.length && sheet.snapshot.rects[0]
        ? normalizeDrawing(sheet.strokes, sheet.snapshot.rects[0])
        : undefined,
    [sheet]
  );
  const openIdRef = useRef(0);
  const frame = useViewportFrame(
    hasPins || sheetOpen || !!flash || !!hovered || !!pressed,
    useCallback(() => setFabBottom(pinButtonBottom()), [])
  );
  const highlightedRef = useRef<Element | null>(null);
  useEffect(() => {
    highlightedRef.current = highlighted;
  }, [highlighted]);

  /** Every sheet opens from a clean slate: no prompt, draft, pick mode or menu. */
  const resetForSheet = useCallback(() => {
    discardPendingCapture(sheetRef.current);
    setArmed(false);
    setMenuOpen(false);
    setHovered(null);
    setPressed(null);
    setDraw(null);
    setDraft('');
    setDiscardPrompt(false);
    setSaving(false);
    lastSheetTopRef.current = null;
  }, []);

  const openNewNote = useCallback(
    (target: Element, input: 'touch' | 'pointer', marks?: { strokes: PixelStroke[]; dropped: number }) => {
      const chain = annChain(target);
      // Before any state changes: the sheet and keyboard must not show in it.
      const snapshot = snapshotPick(chain, path, window.location.href);
      const captureHandle = beginCapture(captureRef.current);
      const snippet = textSnippet(chain[0]);
      const { key, draft: storedDraft } = resolveDraft(path, chain[0], snippet);
      // Without fresh marks, a draft's marks come back with its text, placed
      // on the element where it is now.
      const saved = storedDraft?.drawing;
      const savedRect = snapshot.rects[0];
      const restored = !marks?.strokes && saved && savedRect ? limitStrokes(drawingToPixels(saved, savedRect)) : undefined;
      const strokes = marks?.strokes ?? restored?.strokes;
      const dropped = restored?.dropped ?? marks?.dropped ?? 0;
      resetForSheet();
      openIdRef.current += 1;
      setSheet({
        kind: 'new',
        capture: captureHandle,
        openId: openIdRef.current,
        chain,
        selected: 0,
        input,
        draftKey: key,
        draftSnippet: snippet,
        snapshot,
        ...(strokes ? { strokes, droppedStrokes: dropped } : {}),
      });
    },
    [path, resetForSheet]
  );

  /** Strokes from a gesture (hold-then-drag, ⌘-drag) or from draw mode itself. */
  const strokeSink = useMemo<StrokeSink>(
    () => ({
      begin(points, input) {
        setMenuOpen(false);
        setArmed(false);
        setHovered(null);
        setPressed(null);
        setDraw((d) => (d ? { ...d, live: points, input } : { strokes: [], live: points, input }));
      },
      extend(point) {
        setDraw((d) => (d?.live ? { ...d, live: [...d.live, point] } : d));
      },
      end() {
        setDraw((d) => (d?.live ? { ...d, strokes: [...d.strokes, simplifyStroke(d.live)], live: null } : d));
      },
      // A pinch took over a hold-then-drag: drop the stroke, and leave draw
      // mode if that stroke is what opened it.
      cancel() {
        setDraw((d) => (!d ? d : d.strokes.length ? { ...d, live: null } : null));
      },
    }),
    []
  );

  const finishDrawing = () => {
    if (!draw || draw.strokes.length === 0) return;
    const { strokes, dropped } = limitStrokes(draw.strokes);
    openNewNote(elementUnderStrokes(strokes), draw.input, { strokes, dropped });
  };

  const openNote = useCallback(
    (number: number) => {
      resetForSheet();
      setSheet({ kind: 'note', number });
    },
    [resetForSheet]
  );

  useLongPress({
    enabled: longPressOn && !sheetOpen && !armed && !drawing,
    onArm: setPressed,
    onDisarm: useCallback(() => setPressed(null), []),
    onLongPress: useCallback((target: Element) => openNewNote(target, 'touch'), [openNewNote]),
    stroke: strokeSink,
  });
  useTapToPick(armed, openNewNote);
  useModifierPick(!armed && !sheetOpen && !drawing, openNewNote, setHovered, strokeSink);

  const closeSheet = useCallback(() => {
    discardPendingCapture(sheetRef.current);
    setSheet(null);
    setDraft('');
    setDiscardPrompt(false);
    setSaving(false);
    lastSheetTopRef.current = null;
    window.clearTimeout(revealTimerRef.current);
  }, []);

  /** Close the new-note sheet and forget its autosaved draft. */
  const discardDraft = useCallback(() => {
    if (newNoteDraftKey) {
      clearDraft(newNoteDraftKey);
      discardedAtRef.current.set(newNoteDraftKey, Date.now());
    }
    closeSheet();
  }, [newNoteDraftKey, closeSheet]);

  const onSavingChange = useCallback((isSaving: boolean) => {
    setSaving(isSaving);
    // A pending discard question is moot once the note is on its way.
    if (isSaving) setDiscardPrompt(false);
  }, []);

  const discardedSince = useCallback(
    (key: string, since: number) => (discardedAtRef.current.get(key) ?? -Infinity) >= since,
    []
  );

  /**
   * Escape or swipe-down. A draft with text or marks is not dropped on the
   * first request: the sheet asks, and a second request discards it.
   */
  const requestDismiss = useCallback(() => {
    // A note being saved stays put until the request finishes.
    if (sheet?.kind === 'new' && saving) return;
    if (sheet?.kind === 'new' && (draft.trim() || sheet.strokes?.length)) {
      if (!discardPrompt) setDiscardPrompt(true);
      else discardDraft();
      return;
    }
    closeSheet();
  }, [sheet, saving, draft, discardPrompt, discardDraft, closeSheet]);

  // Navigation takes the layer back to rest. An unsaved draft stays in
  // sessionStorage and comes back when its element is picked again.
  const shownPathRef = useRef(path);
  useEffect(() => {
    if (shownPathRef.current === path) return;
    shownPathRef.current = path;
    closeSheet();
    setMenuOpen(false);
    setArmed(false);
    setHovered(null);
    setPressed(null);
    setDraw(null);
    setFlash(null);
  }, [path, closeSheet]);

  // A note sheet whose note is gone from the loaded list closes.
  useEffect(() => {
    if (sheet?.kind === 'note' && !loading && !sheetNote) closeSheet();
  }, [sheet, loading, sheetNote, closeSheet]);

  /** Close the menu and put focus back on the pin button. */
  const closeMenuToFab = useCallback(() => {
    setMenuOpen(false);
    setFabFocusRequest((n) => n + 1);
  }, []);

  useEffect(() => {
    if (fabFocusRequest) fabRef.current?.focus({ preventScroll: true });
  }, [fabFocusRequest]);

  // Leaving draw mode that the menu opened: focus goes back to the pin button.
  useEffect(() => {
    if (drawing || !drawFromMenuRef.current) return;
    drawFromMenuRef.current = false;
    if (!sheetOpen) setFabFocusRequest((n) => n + 1);
  }, [drawing, sheetOpen]);

  const openMenu = (focus: MenuFocus) => {
    setArmed(false);
    setMenuFocus(focus);
    setMenuOpen(true);
  };

  useLayerEscape(sheetOpen || armed || menuOpen || drawing, () => {
    if (sheetOpen) requestDismiss();
    else if (drawing) setDraw(null);
    else if (armed) setArmed(false);
    else closeMenuToFab();
  });

  // The menu closes on any tap outside it (the tap still does its job).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('.ann-fab-wrap')) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen]);

  const sheetControl = useMemo<SheetControl>(
    () => ({
      requestDismiss,
      discardPrompt: discardPrompt && !saving,
      onKeepEditing: () => setDiscardPrompt(false),
      onDiscard: discardDraft,
    }),
    [requestDismiss, discardPrompt, saving, discardDraft]
  );

  /**
   * The sheet reports its top edge. When it jumps up (the on-screen keyboard
   * opened) the picked element may now be under it, so reveal it again once
   * the keyboard has settled.
   */
  const onSheetTop = useCallback((top: number) => {
    const previous = lastSheetTopRef.current;
    lastSheetTopRef.current = top;
    sheetTopRef.current = top;
    if (previous === null || previous - top <= KEYBOARD_RISE_PX) return;
    window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = window.setTimeout(() => {
      const el = highlightedRef.current;
      if (el) revealAbove(el, sheetTopRef.current);
    }, KEYBOARD_REVEAL_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(revealTimerRef.current), []);

  // Keep the highlighted element in the upper part of the screen.
  useEffect(() => {
    if (!highlighted) return;
    const id = window.requestAnimationFrame(() => revealAbove(highlighted, sheetTopRef.current));
    return () => window.cancelAnimationFrame(id);
  }, [highlighted]);

  // "Show on page": once the note sheet has reported its top edge.
  useEffect(() => {
    if (!reveal) return;
    const id = window.requestAnimationFrame(() => {
      revealAbove(reveal, sheetTopRef.current);
      setReveal(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [reveal]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(id);
  }, [flash]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), toast.error ? ERROR_TOAST_MS : TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  const toggleLongPress = () => {
    const next = !longPressOn;
    if (longPress) longPress.onChange(next);
    else setOwnLongPressOn(next);
  };

  // The sheet on screen now, read when a save that started earlier finishes.
  const sheetRef = useRef<SheetState>(sheet);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);

  const onSaved = (created: CreatedAnnotation, savedOpenId: number, savedPath: string) => {
    // Close only the sheet that made the request: by now the admin may have
    // opened a pin's note, picked another element, or reopened this one.
    const current = sheetRef.current;
    if (current?.kind === 'new' && current.openId === savedOpenId) {
      void current.capture.commit(created);
      closeSheet();
    }
    showToast({ text: 'Saved as', link: { href: created.html_url, label: `#${created.number}` } });
    refreshAfterWrite(savedPath);
  };

  /**
   * A save failed after its sheet left the screen. `draftKey` and `savedPath`
   * identify the element and page whose draft holds the text when `draftKept`.
   */
  const onSaveFailedAway = useCallback(
    (message: string, draftKept: boolean, draftKey: string, savedPath: string) => {
      let hint = '';
      if (draftKept) {
        const current = sheetRef.current;
        if (current?.kind === 'new' && current.draftKey === draftKey) {
          hint = ' The text is kept: close this note and pick the element again to get it back.';
        } else if (savedPath !== pathRef.current) {
          hint = ` The text is kept: go back to ${savedPath} and pick the element again to retry.`;
        } else {
          hint = ' The text is kept: pick the element again to retry.';
        }
      }
      showToast({ text: `Note not saved. ${message}${hint}`, error: true });
    },
    [showToast]
  );

  // `path` in the handlers below is the one from the render that started the
  // request (the handler was passed down then), not the page on screen now.
  const onUpdated = (updated: AnnotationItem) => {
    if (path !== pathRef.current) return;
    setNotes((prev) => prev.map((n) => (n.number === updated.number ? updated : n)));
    refreshAfterWrite(path);
  };

  const onGone = (gone: AnnotationItem) => {
    showToast({ text: 'This note no longer exists' });
    if (path !== pathRef.current) return;
    setNotes((prev) => prev.filter((n) => n.number !== gone.number));
    const current = sheetRef.current;
    if (current?.kind === 'note' && current.number === gone.number) closeSheet();
    refreshAfterWrite(path);
  };

  /** Opens the note on its own (outline, marks) and brings its element into view. */
  const showOnPage = (note: AnnotationItem) => {
    const el = anchors.get(note.number);
    if (!el) return;
    openNote(note.number);
    setReveal(el);
    setFlash(el);
  };

  const openCount = useMemo(() => notes.filter((n) => n.status !== 'done').length, [notes]);
  const ringStatus = notes.some((n) => n.status === 'working')
    ? 'working'
    : openCount > 0
      ? 'open'
      : 'none';
  if (!portalRoot) return null;

  const highlightStyle = rectStyle(
    highlighted ??
      noteTarget ??
      flash ??
      (pressed && resolvePickTarget(pressed)) ??
      (hovered && resolvePickTarget(hovered))
  );
  const highlightVariant = highlighted
    ? 'pick'
    : noteTarget
      ? noteTarget === flash
        ? 'flash'
        : 'pick'
      : flash
        ? 'flash'
        : pressed
          ? 'pick'
          : 'hover';
  // `frame` is read so overlays re-measure on scroll and resize.
  void frame;

  // Marks over the page: the drawing being written, following the selected
  // element from its pick-time rect, or the open note's stored drawing.
  let marks: PixelStroke[] = [];
  if (sheet?.kind === 'new' && sheet.strokes && highlighted?.isConnected) {
    const atPick = sheet.snapshot.rects[sheet.selected];
    if (atPick) marks = reprojectStrokes(sheet.strokes, atPick, rectOf(highlighted));
  } else if (sheetNote && noteTarget?.isConnected && isDrawing(sheetNote.anchor.drawing)) {
    marks = drawingToPixels(sheetNote.anchor.drawing, rectOf(noteTarget));
  }
  const newNoteDrawing =
    sheet?.kind === 'new' && sheet.strokes && sheet.snapshot.rects[sheet.selected]
      ? normalizeDrawing(sheet.strokes, sheet.snapshot.rects[sheet.selected])
      : undefined;

  return createPortal(
    <div {...{ [LAYER_UI_ATTR]: '' }} className="ann-root" data-theme={theme}>
      {highlightStyle && (
        <div
          className="ann-highlight"
          data-variant={highlightVariant}
          style={highlightStyle}
          aria-hidden="true"
        />
      )}

      {!drawing && (
        <Pins
          notes={pinNotes}
          anchors={anchors}
          frame={frame}
          onShown={notesPath === path ? donePins.recordShown : undefined}
          onOpen={(n) => openNote(n.number)}
          onOpenGroup={(group) => {
            resetForSheet();
            setSheet({ kind: 'list', numbers: group.map((n) => n.number) });
          }}
        />
      )}
      <Marks strokes={marks} />

      {draw && (
        <DrawMode
          strokes={draw.strokes}
          live={draw.live}
          sink={strokeSink}
          onUndo={() => setDraw((d) => (d ? { ...d, strokes: d.strokes.slice(0, -1) } : d))}
          onClear={() => setDraw((d) => (d ? { ...d, strokes: [] } : d))}
          onCancel={() => setDraw(null)}
          onDone={finishDrawing}
          autoFocus={draw.fromMenu}
        />
      )}

      {armed && (
        <div className="ann-banner" role="status">
          <CrosshairIcon size={16} />
          <span>Tap anything</span>
          <button type="button" className="ann-banner-cancel" onClick={() => setArmed(false)}>
            Cancel
          </button>
        </div>
      )}

      {!sheetOpen && !drawing && (
        <div className="ann-fab-wrap" style={{ bottom: fabBottom }}>
          {menuOpen && (
            <PinMenu
              id={menuId}
              label="Annotations"
              initialFocus={menuFocus}
              onTabOut={closeMenuToFab}
              error={loadError}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ann-menu-item"
                onClick={() => {
                  closeMenuToFab();
                  setArmed(true);
                }}
              >
                <CrosshairIcon size={18} /> Annotate
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ann-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setArmed(false);
                  drawFromMenuRef.current = true;
                  setDraw({ strokes: [], live: null, input: 'pointer', fromMenu: true });
                }}
              >
                <PenIcon size={18} /> Draw
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ann-menu-item"
                onClick={() => {
                  resetForSheet();
                  setSheet({ kind: 'list' });
                  void refresh();
                }}
              >
                <ListIcon size={18} /> Notes on this page
                <span className="ann-menu-count">{notes.length}</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={longPressOn}
                tabIndex={-1}
                className="ann-menu-item"
                onClick={toggleLongPress}
              >
                <HandIcon size={18} /> Long-press
                <span className="ann-menu-count">{longPressOn ? 'On' : 'Off'}</span>
              </button>
            </PinMenu>
          )}
          <button
            ref={fabRef}
            type="button"
            className="ann-fab"
            data-ring={ringStatus}
            aria-label={`Annotations, ${openCount} open on this page`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={(e) => {
              if (menuOpen) {
                setMenuOpen(false);
                return;
              }
              // `detail` is 0 for a click made with Enter or Space.
              openMenu(e.detail === 0 ? 'first' : 'menu');
            }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              openMenu(e.key === 'ArrowDown' ? 'first' : 'last');
            }}
          >
            <NotePlusIcon size={20} />
            {openCount > 0 && <span className="ann-fab-count">{openCount}</span>}
            {loadError && <span className="ann-fab-alert" aria-hidden="true">!</span>}
          </button>
        </div>
      )}

      <SheetControlContext.Provider value={sheetControl}>
      {sheet?.kind === 'new' && newNoteDraftKey && (
        <NewNoteSheet
          key={sheet.openId}
          client={client}
          draftKey={newNoteDraftKey}
          draftSnippet={sheet.draftSnippet}
          onSavingChange={onSavingChange}
          discardedSince={discardedSince}
          onSaveFailedAway={onSaveFailedAway}
          chain={sheet.chain}
          selected={sheet.selected}
          onSelect={(i) => setSheet({ ...sheet, selected: i })}
          path={path}
          input={sheet.input}
          snapshot={sheet.snapshot}
          drawing={newNoteDrawing}
          droppedStrokes={sheet.droppedStrokes}
          draftDrawing={draftDrawing}
          draftAnchor={sheet.snapshot.anchors[0]}
          host={context}
          onSaved={(created, _key, savedPath) => onSaved(created, sheet.openId, savedPath)}
          onClose={closeSheet}
          onTopChange={onSheetTop}
          onDraftChange={(text) => {
            setDraft(text);
            setDiscardPrompt(false);
          }}
        />
      )}
      {sheet?.kind === 'note' && sheetNote && (
        <NoteSheet
          client={client}
          note={sheetNote}
          moved={!anchors.get(sheetNote.number)}
          onHidePin={
            shownDone.includes(sheetNote)
              ? () => {
                  donePins.hide([sheetNote]);
                  closeSheet();
                }
              : undefined
          }
          onTopChange={(top) => {
            sheetTopRef.current = top;
          }}
          onUpdated={onUpdated}
          onGone={onGone}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'list' && (
        <NotesListSheet
          client={client}
          notes={notes}
          anchors={anchors}
          loading={loading}
          error={loadError}
          onShow={showOnPage}
          onUpdated={onUpdated}
          onGone={onGone}
          onClose={closeSheet}
          only={sheet.numbers}
          onShowAll={() => setSheet({ kind: 'list' })}
          onHideDonePins={
            !sheet.numbers && shownDone.length > 0 ? () => donePins.hide(shownDone) : undefined
          }
        />
      )}
      </SheetControlContext.Provider>

      {toast && (
        <div className="ann-toast" role={toast.error ? 'alert' : 'status'}>
          {toast.text}
          {toast.link && (
            <>
              {' '}
              <a href={toast.link.href} target="_blank" rel="noreferrer">
                {toast.link.label}
              </a>
            </>
          )}
        </div>
      )}
    </div>,
    portalRoot
  );
}
