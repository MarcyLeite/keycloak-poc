import { defineConfig } from 'vite';

// Top-level await in main.js needs a modern build target.
export default defineConfig({
  build: { target: 'es2022' },
});
