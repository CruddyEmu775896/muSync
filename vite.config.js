import { defineConfig } from 'vite';

export default defineConfig({
  base: '/muSync/',
  build: {
    target: 'es2020',
    outDir: 'dist'
  }
});
