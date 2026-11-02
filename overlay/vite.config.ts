import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Reine Browser-Anwendung: der Katalog liegt als statische Dateien in public/catalog
// (erzeugt von scripts/build-catalog.mjs, siehe predev/prebuild in package.json).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Im Entwicklungsmodus laeuft der Sync-Server separat (server/index.mjs).
    proxy: {
      '/api': {
        target: process.env.SWEET3D_SYNC_URL ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
