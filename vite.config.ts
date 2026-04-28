/// <reference types="vitest" />
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
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['tests/unit/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // Emit JUnit XML so the GitHub Actions Test Reporter can annotate PRs.
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      // text = stdout summary, html = local browsing, lcov = future tooling.
      reporter: ['text', 'html', 'lcov'],
      include: ['src/api/**', 'src/hooks/**'],
      exclude: ['src/screens/**', 'src/components/**', 'src/main.tsx', 'src/App.tsx'],
      reportsDirectory: 'test-results/coverage',
    },
  },
});
