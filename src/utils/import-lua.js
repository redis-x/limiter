
import libFs             from 'node:fs/promises';
import libPath           from 'node:path';
import { fileURLToPath } from 'node:url';

const import_meta_url = import.meta?.url;
const current_dir = typeof import_meta_url === 'string'
	? libPath.dirname(
		fileURLToPath(import_meta_url),
	)
	// eslint-disable-next-line unicorn/prefer-module
	: __dirname;

// eslint-disable-next-line unicorn/prefer-top-level-await
const package_root_dir_promise = (async () => {
	let current_lookup_dir = current_dir;

	while (true) {
		const package_json_path = libPath.join(
			current_lookup_dir,
			'package.json',
		);

		try {
			// eslint-disable-next-line no-await-in-loop
			await libFs.stat(package_json_path);

			return current_lookup_dir;
		}
		catch {
			current_lookup_dir = libPath.join(
				current_lookup_dir,
				'..',
			);

			if (current_lookup_dir === '/') {
				throw new Error('Could not find package.json');
			}
		}
	}
})();

/**
 * Reads a file from the file system.
 * @param {string} path The path to the file.
 * @returns {Promise<string>} The contents of the file.
 */
export async function importLua(path) {
	const content = await libFs.readFile(
		libPath.join(
			await package_root_dir_promise,
			'lua',
			path,
		),
		'utf8',
	);

	return content
		.replaceAll(/--.*\n/g, '')
		.replaceAll(/\s+/g, ' ')
		.trim();
}
