export function JsonView({ value }: { value: unknown }) {
	return (
		<pre className="max-h-[70vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
			{JSON.stringify(value, null, 2)}
		</pre>
	)
}
