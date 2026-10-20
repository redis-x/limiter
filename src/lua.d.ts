declare module '*.lua' {
	const source: string;
	// eslint-disable-next-line no-restricted-exports -- Matches the text loader's default export.
	export default source;
}
