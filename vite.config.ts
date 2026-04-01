import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // VITE_BASE_PATH is set in CI to /zero-budget-ss-plus-mobile/ for GitHub Pages.
  // Locally it defaults to / so dev server works normally.
  base: process.env.VITE_BASE_PATH ?? '/',
  build: {
    outDir: 'dist/app',
  },
});
