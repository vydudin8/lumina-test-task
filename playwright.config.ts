import { defineConfig, devices } from '@playwright/test'

const port = 3100
const env = {
	DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://lumina:lumina@localhost:5432/lumina_e2e',
	SESSION_SECRET: 'e2e-secret-0123456789abcdef0123456789',
	PORT: String(port),
	LOG_LEVEL: 'warn',
}

export default defineConfig({
	testDir: './e2e',
	forbidOnly: Boolean(process.env.CI),
	reporter: process.env.CI ? 'list' : 'html',
	use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		// A fresh database each run: reset, migrate, seed, then serve the production build.
		command: 'pnpm build && node src/server/seed/main.ts --reset && node src/server/main.ts',
		url: `http://localhost:${port}/api/health`,
		env,
		reuseExistingServer: false,
		timeout: 120_000,
	},
})
