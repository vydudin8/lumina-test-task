import { cn } from '#client/lib/utils.ts'
import { ExternalLink } from 'lucide-react'

// Domains come from providers: only a bare hostname becomes a link, anything else stays plain text.
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

// `quiet`: plain text colour and no icon, for a list where the domain sits under a link already.
export function DomainLink({ domain, className, quiet }: { domain: string; className?: string; quiet?: boolean }) {
	if (!HOSTNAME.test(domain)) return domain
	return (
		<a
			href={`https://${domain}`}
			target="_blank"
			rel="noreferrer"
			className={cn('link', quiet && 'text-foreground', className)}
		>
			{domain}
			{!quiet && <ExternalLink aria-hidden className="ml-1 inline size-3 align-[-1px]" />}
			<span className="sr-only"> (opens in a new tab)</span>
		</a>
	)
}
