import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The node server (tools/local-review/review.js) serves the build output from
// ../dist. In dev, Vite serves the UI and proxies /api to that server.
// changeOrigin stays false on purpose: Host and Origin both stay
// 127.0.0.1:5173, which is exactly what lib/http.js checkOrigin accepts.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    // Same loopback address as the review server; "localhost" may resolve to
    // ::1 only and then nothing that expects 127.0.0.1 can reach it.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4321', changeOrigin: false },
    },
  },
  test: {
    root: here,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
