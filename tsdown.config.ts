// eslint-disable-next-line n/no-unpublished-import -- Build tooling is a development dependency.
import { defineConfig } from 'tsdown';

// eslint-disable-next-line no-restricted-exports
export default defineConfig({
	loader: {
		'.lua': 'text',
	},
});
