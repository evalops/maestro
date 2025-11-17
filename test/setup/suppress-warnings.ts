const SUPPRESSED_WARNINGS = [/^\[lsp\] root resolver /, /^\[Config Warning\]/];

const originalWarn = console.warn.bind(console);

console.warn = ((...args: unknown[]) => {
	const [first] = args;
	if (typeof first === "string") {
		const shouldSuppress = SUPPRESSED_WARNINGS.some((pattern) =>
			pattern.test(first),
		);
		if (shouldSuppress) {
			return;
		}
	}
	originalWarn(...(args as Parameters<typeof console.warn>));
}) as typeof console.warn;
