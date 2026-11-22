/**
 * The lazy entry: loads the annotation layer only for viewers who may annotate.
 * @actor Host developer: embeds the annotation layer in a page
 * @runsIn browser
 */
import React, { Component, lazy, Suspense, useMemo, type ComponentType, type ReactNode } from 'react';
import type { FixFastProps } from './FixFast';

/** What `load` resolves to: the package's main entry, or any module exporting `FixFast`. */
export interface FixFastModule {
  FixFast: ComponentType<FixFastProps>;
}

export type LazyFixFastProps = FixFastProps & {
  /**
   * Whether the viewer may annotate. While false, nothing is downloaded,
   * rendered or attached to the page.
   */
  enabled: boolean;
  /** Shown while the layer's code loads. Defaults to nothing. */
  fallback?: ReactNode;
  /** Called when the layer's code fails to load or the layer throws. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
};

interface BoundaryProps {
  onError: (error: unknown) => void;
  children: ReactNode;
}

/** Keeps a failed download (offline, a stale chunk after a deploy) from taking down the host page. */
class LayerBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const logError = (error: unknown) => console.error('fixfast failed to load', error);

/**
 * Returns a component that downloads the layer only when `enabled` is true.
 *
 * `load` must be written in the host's code, as `() => import('fixfast')`,
 * so the host's bundler puts the layer (and its CSS, when the loaded module imports it) in a
 * separate chunk. Call this once at module scope, not during render.
 *
 * If loading fails, the layer renders nothing and `onError` is called. Turning `enabled` off
 * and on again, or remounting, downloads it again.
 */
export function createLazyFixFast(
  load: () => Promise<FixFastModule>
): ComponentType<LazyFixFastProps> {
  let Lazy: ComponentType<FixFastProps> | null = null;
  const getLazy = () => {
    Lazy ??= lazy(async () => {
      try {
        return { default: (await load()).FixFast };
      } catch (error) {
        Lazy = null;
        throw error;
      }
    });
    return Lazy;
  };

  function LazyFixFast({ enabled, fallback = null, onError = logError, ...props }: LazyFixFastProps) {
    const Layer = useMemo(() => (enabled ? getLazy() : null), [enabled]);
    if (!Layer) return null;
    return (
      <LayerBoundary onError={onError}>
        <Suspense fallback={fallback}>
          <Layer {...props} />
        </Suspense>
      </LayerBoundary>
    );
  }
  return LazyFixFast;
}
