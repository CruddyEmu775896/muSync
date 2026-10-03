import { defineConfig } from 'vite';

export default defineConfig({
  base: '/musync/',
  build: {
    target: 'es2020',
    outDir: 'dist'
  }
});
