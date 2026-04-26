export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError";
	}

	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}
