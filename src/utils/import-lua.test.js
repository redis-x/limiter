
import {
	test,
	expect,
}                    from 'vitest';
import { importLua } from './import-lua.js';

test('existing file', async () => {
	await expect(
		importLua('get.lua'),
	).resolves.toBeTypeOf('string');
});

test('not-existing file', async () => {
	await expect(
		importLua('no-such-file.lua'),
	).rejects.toBeInstanceOf(Error);
});
