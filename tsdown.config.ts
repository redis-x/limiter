import { defineConfig } from 'tsdown';

// eslint-disable-next-line no-restricted-exports
export default defineConfig({
	loader: {
		'.lua': 'text',
	},
});
