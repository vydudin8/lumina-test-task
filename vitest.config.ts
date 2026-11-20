import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
					exclude: [...configDefaults.exclude, 'src/**/*.db.test.ts'],
				},
			},
			{
				test: {
					name: 'db',
					include: ['src/**/*.db.test.ts'],
					globalSetup: ['src/server/test/global-setup.ts'],
					hookTimeout: 60_000,
					testTimeout: 30_000,
				},
			},
		],
	},
})
