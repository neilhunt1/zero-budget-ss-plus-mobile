/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_BASE_PATH is set in CI to /zero-budget-ss-plus-mobile/ for GitHub Pages.
// Locally it defaults to / so dev server works normally.
const base = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Zero Budget',
        short_name: 'Budget',
        description: 'Personal budgeting app',
        theme_color: '#1a1a2e',
        background_color: '#f5f5f7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: null,
        runtimeCaching: [],
      },
    }),
  ],
  base,
  build: {
    outDir: 'dist/app',
  },
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['tests/unit/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Emit JUnit XML so the GitHub Actions Test Reporter can annotate PRs.
    reporters: ['verbose', 'junit'],
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
