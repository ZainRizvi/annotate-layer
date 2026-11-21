import React, { Component, lazy, Suspense, useMemo, type ComponentType, type ReactNode } from 'react';
import type { AnnotateLayerProps } from './AnnotateLayer';

/** What `load` resolves to: the package's main entry, or any module exporting `AnnotateLayer`. */
export interface AnnotateLayerModule {
  AnnotateLayer: ComponentType<AnnotateLayerProps>;
}

export type LazyAnnotateLayerProps = AnnotateLayerProps & {
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

const logError = (error: unknown) => console.error('annotate-layer failed to load', error);

/**
 * Returns a component that downloads the layer only when `enabled` is true.
 *
 * `load` must be written in the host's code, as `() => import('@zainrizvi/annotate-layer')`,
 * so the host's bundler puts the layer (and its CSS, when the loaded module imports it) in a
 * separate chunk. Call this once at module scope, not during render.
 *
 * If loading fails, the layer renders nothing and `onError` is called. Turning `enabled` off
 * and on again, or remounting, downloads it again.
 */
export function createLazyAnnotateLayer(
  load: () => Promise<AnnotateLayerModule>
): ComponentType<LazyAnnotateLayerProps> {
  let Lazy: ComponentType<AnnotateLayerProps> | null = null;
  const getLazy = () => {
    Lazy ??= lazy(async () => {
      try {
        return { default: (await load()).AnnotateLayer };
      } catch (error) {
        Lazy = null;
        throw error;
      }
    });
    return Lazy;
  };

  function LazyAnnotateLayer({ enabled, fallback = null, onError = logError, ...props }: LazyAnnotateLayerProps) {
    const Layer = useMemo(() => (enabled ? getLazy() : null), [enabled]);
    if (!Layer) return null;
    return (
      <LayerBoundary onError={onError}>
        <Suspense fallback={fallback}>
          <Layer {...(props as AnnotateLayerProps)} />
        </Suspense>
      </LayerBoundary>
    );
  }
  return LazyAnnotateLayer;
}
