import React, { lazy, Suspense, useMemo, type ComponentType, type ReactNode } from 'react';
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
};

/**
 * Returns a component that downloads the layer only when `enabled` is true.
 *
 * `load` must be written in the host's code, as `() => import('@zainrizvi/annotate-layer')`,
 * so the host's bundler puts the layer (and its CSS, when the loaded module imports it) in a
 * separate chunk. Call this once at module scope, not during render.
 */
export function createLazyAnnotateLayer(
  load: () => Promise<AnnotateLayerModule>
): ComponentType<LazyAnnotateLayerProps> {
  let Lazy: ComponentType<AnnotateLayerProps> | null = null;
  const getLazy = () => {
    Lazy ??= lazy(async () => ({ default: (await load()).AnnotateLayer }));
    return Lazy;
  };

  function LazyAnnotateLayer({ enabled, fallback = null, ...props }: LazyAnnotateLayerProps) {
    const Layer = useMemo(() => (enabled ? getLazy() : null), [enabled]);
    if (!Layer) return null;
    return (
      <Suspense fallback={fallback}>
        <Layer {...(props as AnnotateLayerProps)} />
      </Suspense>
    );
  }
  return LazyAnnotateLayer;
}
