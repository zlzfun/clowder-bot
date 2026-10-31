import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3210', '/xbot-api': 'http://127.0.0.1:3210' } },
  build: { outDir: '../dist/client', emptyOutDir: true },
});
