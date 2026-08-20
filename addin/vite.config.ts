import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Served by the Express app under /addin (same origin as the API, so no CORS setup).
export default defineConfig({
  base: '/addin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        taskpane: resolve(__dirname, 'taskpane.html'),
        auth: resolve(__dirname, 'auth.html'),
        spike: resolve(__dirname, 'spike.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3001' },
  },
})
