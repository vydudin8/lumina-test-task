import { setTimeout as wait } from 'node:timers/promises'

export type Clock = () => Date

export const systemClock: Clock = () => new Date()

// For the background loops: unref'd, so it never holds the process open, and over at once when the loop is stopped.
export const stoppableSleep = (signal: AbortSignal) => (ms: number) =>
	wait(ms, undefined, { signal, ref: false }).catch(() => undefined)
