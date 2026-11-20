import type { Config } from 'prettier'

export default {
	useTabs: true,
	trailingComma: 'all',
	semi: false,
	singleQuote: true,
	printWidth: 120,
	plugins: ['prettier-plugin-organize-imports'],
	overrides: [{ files: ['*.yml', '*.yaml', '*.md'], options: { useTabs: false, tabWidth: 2 } }],
} satisfies Config
