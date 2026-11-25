import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{ ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'fixtures/**', 'playwright-report/**', 'test-results/**'] },
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ['**/*.{ts,tsx}'] })),
	{
		files: ['**/*.{ts,tsx}'],
		languageOptions: {
			globals: globals.node,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/require-await': 'error',
			// `const { secret, ...rest } = row` is how a field is dropped from a response.
			'@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
		},
	},
	{
		files: ['src/client/**/*.{ts,tsx}'],
		plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
		languageOptions: { globals: globals.browser },
		rules: { ...reactHooks.configs.flat.recommended.rules, ...reactRefresh.configs.vite.rules },
	},
	// Vendored shadcn/ui components export their variant helpers next to the component.
	{ files: ['src/client/components/ui/**'], rules: { 'react-refresh/only-export-components': 'off' } },
	eslintConfigPrettier,
)
