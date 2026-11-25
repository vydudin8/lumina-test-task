import { Button } from '#client/components/ui/button.tsx'
import { cn } from '#client/lib/utils.ts'
import { CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'

export interface ToastInput {
	title: string
	description?: string
	// pending: work still going on; it stays up, without a countdown, until updateToast gives it a result.
	tone?: 'success' | 'error' | 'pending'
	action?: { label: string; to: string }
}

type StoredToast = ToastInput & { id: number; open: boolean }

// A tiny module store, so any mutation can raise a toast without threading a context through.
let toasts: StoredToast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function toast(input: ToastInput) {
	const id = nextId++
	toasts = [...toasts, { ...input, id, open: true }]
	emit()
	return id
}

// Swaps a toast's content in place; one the user has already closed stays closed.
export function updateToast(id: number, input: ToastInput) {
	toasts = toasts.map((item) => (item.id === id ? { ...input, id, open: item.open } : item))
	emit()
}

const dismiss = (id: number) => {
	toasts = toasts.map((item) => (item.id === id ? { ...item, open: false } : item))
	emit()
	// Leave time for the exit animation before dropping it from the store.
	setTimeout(() => {
		toasts = toasts.filter((item) => item.id !== id)
		emit()
	}, 300)
}

// Sideways travel that counts as a swipe; less than CLICK_PX in any direction counts as a plain click.
const SWIPE_PX = 48
const CLICK_PX = 4
const FLING_MS = 180

export function Toaster() {
	const items = useSyncExternalStore(subscribe, () => toasts)

	return (
		// Radix keeps the live region only. Its timer is off: its pause is shared by every toast and can stick when a
		// toast is closed under the pointer. Each toast's countdown bar times it instead (see below).
		<ToastPrimitive.Provider duration={Infinity}>
			{items.map((item) => (
				// A new tone mounts it again, so Radix announces the result as it did the start.
				<ToastItem key={`${item.id}:${item.tone}`} item={item} />
			))}
			<ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-100 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
		</ToastPrimitive.Provider>
	)
}

function ToastItem({ item }: { item: StoredToast }) {
	const navigate = useNavigate()
	const start = useRef<{ x: number; y: number } | null>(null)
	const [dragX, setDragX] = useState(0)
	const [dragging, setDragging] = useState(false)
	const [flung, setFlung] = useState(false)
	const error = item.tone === 'error'
	const pending = item.tone === 'pending'
	const Icon = error ? CircleAlert : pending ? LoaderCircle : CircleCheck

	return (
		<ToastPrimitive.Root
			open={item.open}
			onOpenChange={(open) => !open && dismiss(item.id)}
			// Radix swipes one way only. This swipes left or right, and a plain click anywhere closes the toast too;
			// preventDefault also skips Radix's own swipe handlers. Buttons inside keep their own clicks.
			onPointerDown={(event) => {
				if (event.button !== 0 || (event.target as Element).closest('button')) return
				event.preventDefault()
				event.currentTarget.setPointerCapture(event.pointerId)
				start.current = { x: event.clientX, y: event.clientY }
				setDragging(true)
			}}
			onPointerMove={(event) => {
				if (start.current) setDragX(event.clientX - start.current.x)
			}}
			onPointerUp={(event) => {
				if (!start.current) return
				const dx = event.clientX - start.current.x
				const dy = event.clientY - start.current.y
				start.current = null
				setDragging(false)
				if (Math.abs(dx) >= SWIPE_PX) {
					// Carry on the way it was thrown, then close without the usual exit animation.
					setFlung(true)
					setTimeout(() => dismiss(item.id), FLING_MS)
				} else if (Math.hypot(dx, dy) < CLICK_PX) dismiss(item.id)
				else setDragX(0)
			}}
			onPointerCancel={() => {
				start.current = null
				setDragging(false)
				setDragX(0)
			}}
			style={{
				transform: `translateX(${flung ? Math.sign(dragX) * 480 : dragX}px)`,
				opacity: flung ? 0 : 1 - Math.min(Math.abs(dragX) / 240, 0.5),
				transition: dragging ? 'none' : `transform ${FLING_MS}ms ease-out, opacity ${FLING_MS}ms ease-out`,
			}}
			className={cn(
				// touch-pan-y: a finger can still scroll the page up and down through a toast.
				'group relative flex touch-pan-y items-start gap-3 overflow-hidden rounded-xl border bg-popover py-3 pr-2 pl-3 text-sm text-popover-foreground shadow-[0_10px_30px_-10px_oklch(0.2_0.02_260/0.25)] select-none',
				'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-4',
				!flung && 'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
			)}
		>
			<span
				aria-hidden
				className={cn(
					'grid size-7 shrink-0 place-items-center rounded-full',
					error
						? 'bg-destructive-soft text-destructive'
						: pending
							? 'bg-muted text-muted-foreground'
							: 'bg-success-soft text-success',
				)}
			>
				<Icon className={cn('size-4', pending && 'animate-spin')} />
			</span>
			<div className="min-w-0 flex-1 space-y-0.5 pt-1">
				<ToastPrimitive.Title className="leading-5 font-medium">{item.title}</ToastPrimitive.Title>
				{item.description && (
					<ToastPrimitive.Description className="text-muted-foreground">{item.description}</ToastPrimitive.Description>
				)}
				{item.action && (
					<ToastPrimitive.Action altText={item.action.label} asChild>
						<Button size="xs" variant="outline" className="mt-1.5" onClick={() => void navigate(item.action!.to)}>
							{item.action.label}
						</Button>
					</ToastPrimitive.Action>
				)}
			</div>
			<ToastPrimitive.Close
				aria-label="Dismiss"
				className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<X className="size-3.5" />
			</ToastPrimitive.Close>
			{/* The countdown is the timer: 4 s of CSS animation, paused while the pointer or focus is on this toast,
			    and the toast closes when it runs out. A pending toast has none; it starts once the result replaces it. */}
			{!pending && (
				<span
					aria-hidden
					onAnimationEnd={() => dismiss(item.id)}
					className={cn(
						'absolute inset-x-0 bottom-0 h-0.5 origin-left animate-[toast-countdown_4s_linear_forwards] group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]',
						error ? 'bg-destructive/60' : 'bg-success/60',
					)}
				/>
			)}
		</ToastPrimitive.Root>
	)
}
