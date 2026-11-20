import { z } from 'zod'

const envSchema = z.object({
	DATABASE_URL: z.url(),
	SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
	PORT: z.coerce.number().int().default(3000),
	FAKE_WORLD_URL: z.url().default('http://localhost:4000'),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Config = z.infer<typeof envSchema>

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => envSchema.parse(env)
