import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * SWC compiles the tests with the decorator metadata NestJS dependency
 * injection relies on (esbuild cannot emit it).
 */
export const decoratorMetadata = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
  },
});

/** Unit tests: `src/**\/*.spec.ts`, no Docker needed (`pnpm test`). */
export default defineConfig({
  plugins: [decoratorMetadata],
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    },
  },
});
