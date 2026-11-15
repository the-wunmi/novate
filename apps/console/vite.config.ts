import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Everything the console calls on the API. In development Vite forwards it to the server. */
const API = ['/me', '/auth', '/tenants', '/deals', '/cases', '/cycles', '/presets'];
const target = process.env.NOVATE_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  base: '/console/',
  plugins: [react()],
  server: {
    port: 5173,
    // The API refuses a cookie-authenticated write from another origin, so in development the proxy
    // presents requests as coming from the API's own origin, which is what the built console does.
    proxy: Object.fromEntries(
      API.map((path) => [path, { target, changeOrigin: true, headers: { origin: target } }]),
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
