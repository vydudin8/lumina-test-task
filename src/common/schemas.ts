import { z } from 'zod'

export const roleSchema = z.enum(['rep', 'lead'])
export type Role = z.infer<typeof roleSchema>

export const userSchema = z.object({ id: z.string(), name: z.string(), role: roleSchema })
export type User = z.infer<typeof userSchema>

export const pickUserSchema = z.object({ userId: z.string().min(1).max(100) })
