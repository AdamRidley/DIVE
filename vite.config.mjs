import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  // Keep public/ for `npm run dev`. Do not ship PoC fixtures in the library package.
  publicDir: command === 'build' ? false : 'public',
  build: {
    lib: {
      entry: path.resolve(root, 'src/index.ts'),
      name: 'DIVE',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'dive.js' : 'dive.iife.js'),
    },
    sourcemap: true,
    emptyOutDir: true,
    target: 'es2022',
  },
}));
