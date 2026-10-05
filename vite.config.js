import { defineConfig } from 'vite';

export default defineConfig({
  base: '/muSync/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: false
  },
  optimizeDeps: {
    include: ['sql.js']
  },
  worker: {
    format: 'es'
  }
});
