import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { tsconfigPaths: true },
	build: {
		outDir: 'dist/client',
		// One chunk on purpose: an internal desktop tool, ~260 kB gzipped and cached after the first visit. The limit
		// stays a tripwire for real growth (the bundle is ~850 kB minified).
		chunkSizeWarningLimit: 900,
	},
	server: {
		proxy: {
			// Keep the browser's Host: the API's CSRF check compares Origin with it, and Vite's default rewrite fails it.
			'/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
		},
	},
})
