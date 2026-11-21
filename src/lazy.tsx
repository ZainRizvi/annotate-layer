import React, { Component, lazy, Suspense, useMemo, type ComponentType, type ReactNode } from 'react';
import type { FixtProps } from './Fixt';

/** What `load` resolves to: the package's main entry, or any module exporting `Fixt`. */
export interface FixtModule {
  Fixt: ComponentType<FixtProps>;
}

export type LazyFixtProps = FixtProps & {
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

const logError = (error: unknown) => console.error('fixt failed to load', error);

/**
 * Returns a component that downloads the layer only when `enabled` is true.
 *
 * `load` must be written in the host's code, as `() => import('fixt')`,
 * so the host's bundler puts the layer (and its CSS, when the loaded module imports it) in a
 * separate chunk. Call this once at module scope, not during render.
 *
 * If loading fails, the layer renders nothing and `onError` is called. Turning `enabled` off
 * and on again, or remounting, downloads it again.
 */
export function createLazyFixt(
  load: () => Promise<FixtModule>
): ComponentType<LazyFixtProps> {
  let Lazy: ComponentType<FixtProps> | null = null;
  const getLazy = () => {
    Lazy ??= lazy(async () => {
      try {
        return { default: (await load()).Fixt };
      } catch (error) {
        Lazy = null;
        throw error;
      }
    });
    return Lazy;
  };

  function LazyFixt({ enabled, fallback = null, onError = logError, ...props }: LazyFixtProps) {
    const Layer = useMemo(() => (enabled ? getLazy() : null), [enabled]);
    if (!Layer) return null;
    return (
      <LayerBoundary onError={onError}>
        <Suspense fallback={fallback}>
          <Layer {...(props as FixtProps)} />
        </Suspense>
      </LayerBoundary>
    );
  }
  return LazyFixt;
}
