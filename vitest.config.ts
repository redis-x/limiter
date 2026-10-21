import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';

// eslint-disable-next-line no-restricted-exports
export default defineConfig({
	test: {
		// Integration tests reset the shared Redis database before each case.
		fileParallelism: false,
	},
	plugins: [
		{
			name: 'lua-text',
			enforce: 'pre',
			async load(id) {
				if (!id.endsWith('.lua')) {
					return null;
				}

				const source = await readFile(id, 'utf8');
				return {
					code: `export default ${JSON.stringify(source)};`,
					map: null,
				};
			},
		},
	],
});
