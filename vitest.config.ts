import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.d.ts'],
    },
    // web-tree-sitter is a CJS module with no ESM exports field.
    // Externalising it bypasses Vite's CJS transform so Node's native require()
    // handles it, which correctly exposes the Parser constructor.
    //
    // @grpc/proto-loader pulls protobufjs, which relies on a runtime
    // eval-require of the `long` package. Vite's ESM transform breaks that
    // path (util.Long stays undefined, proto-loader throws
    // `util.Long.fromNumber is not a function` when a proto is loaded).
    // Externalising the grpc stack keeps Node's native resolver in charge.
    server: {
      deps: {
        external: [
          'web-tree-sitter',
          '@grpc/grpc-js',
          '@grpc/proto-loader',
          'protobufjs',
          'long',
        ],
      },
    },
  },
  resolve: {
    conditions: ['import', 'node'],
  },
});
