import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works from any subdirectory (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  plugins: [
    VitePWA({
      registerType: 'prompt', // never reload mid-transfer; the UI offers the update when idle
      includeAssets: ['icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,webmanifest}'],
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'LED Hat Controller',
        short_name: 'LED Hat',
        description: 'Local BLE controller for an iLEDColor LED display',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#111111',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
