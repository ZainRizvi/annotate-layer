/** Bundles the package: the main and lazy entries as ES modules with type declarations. */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', lazy: 'src/lazy.tsx' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  // React Server Components hosts (Next.js App Router) need the directive on each entry.
  banner: { js: "'use client';" },
});
