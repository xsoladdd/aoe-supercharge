import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = process.env.SUPERCHARGE_DEV_DAEMON ?? 'http://127.0.0.1:4280';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@aoe-supercharge/core/shared': fileURLToPath(new URL('../core/src/shared/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../cli/dist/ui', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5180,
    // Dev only: forward to the daemon as if the request came from its own origin, so the daemon's
    // Host/Origin gate and CSRF check stay strict. Cookies are per host, not per port, so the
    // sign-in cookie set through this proxy works on localhost:5180.
    proxy: {
      '/api': { target: daemon, changeOrigin: true, headers: { origin: daemon } },
      '/auth': { target: daemon, changeOrigin: true, headers: { origin: daemon } },
    },
  },
});
