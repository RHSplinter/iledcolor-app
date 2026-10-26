import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const scannerAssets = new Map([
  ['ocr/worker.min.js', require.resolve('tesseract.js/dist/worker.min.js')],
  ['ocr/tesseract-core-lstm.wasm.js', require.resolve('tesseract.js-core/tesseract-core-lstm.wasm.js')],
  ['ocr/lang/eng.traineddata.gz', require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')],
  ['licenses/tesseract-js-APACHE-2.0.txt', require.resolve('tesseract.js/LICENSE.md')],
  ['licenses/tesseract-core-APACHE-2.0.txt', require.resolve('tesseract.js-core/LICENSE')],
]);

const scannerOcrAssets: Plugin = {
  name: 'scanner-ocr-assets',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const entry = [...scannerAssets].find(([name]) => pathname.endsWith(`/${name}`));
      if (!entry) { next(); return; }
      response.setHeader('Content-Type', entry[0].endsWith('.gz') ? 'application/gzip' : entry[0].endsWith('.js') ? 'application/javascript' : 'text/plain; charset=utf-8');
      response.end(readFileSync(entry[1]));
    });
  },
  generateBundle() {
    for (const [fileName, sourcePath] of scannerAssets) {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(sourcePath) });
    }
  },
};

// Native versionName/MARKETING_VERSION are kept in sync with package.json by scripts/release-version.mjs.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Relative base so the build works from any subdirectory (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  plugins: [
    scannerOcrAssets,
    VitePWA({
      registerType: 'prompt', // never reload mid-transfer; the UI offers the update when idle
      includeAssets: ['icon.svg', 'licenses/*.txt'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,webmanifest,txt,gz}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
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
