/**
 * The package entry: the annotation layer, its client and the types a host page uses.
 * @actor Host developer: embeds the annotation layer in a page
 * @runsIn browser
 */
export {
  FixFast,
  type FixFastOptions,
  type FixFastProps,
  type FixFastSource,
} from './FixFast';
export {
  AnnotateError,
  annotationErrorMessage,
  createFetchClient,
  isAnnotationGone,
  type AnnotateErrorKind,
  type FetchClientOptions,
} from './client';
export { ANNOTATION_TYPES } from './types';
export type {
  AnnotateClient,
  AnnotateHostContext,
  AnnotateLongPress,
  AnnotateStorage,
  AnnotationAnchor,
  AnnotationContext,
  AnnotationDrawing,
  AnnotationItem,
  AnnotationRect,
  AnnotationStatus,
  AnnotationStroke,
  AnnotationType,
  CaptureHandle,
  CreateAnnotationInput,
  CreatedAnnotation,
  NoteCapture,
} from './types';
