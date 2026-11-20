import { z } from 'zod'

const envSchema = z.object({
	DATABASE_URL: z.url(),
	SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
	PORT: z.coerce.number().int().default(3000),
	FAKE_WORLD_URL: z.url().default('http://localhost:4000'),
	MAIL_API_URL: z.url().optional(),
	MAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
	MAIL_WEBHOOK_SECRET: z.string().min(16, 'MAIL_WEBHOOK_SECRET must be at least 16 characters'),
	// Without a key the deterministic stub writes the lines (see README).
	ANTHROPIC_API_KEY: z.string().min(1).optional(),
	LLM_MODEL: z.string().default('claude-haiku-5-5'),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Config = z.infer<typeof envSchema>

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => envSchema.parse(env)
