export interface OAuthRefreshErrorOptions {
	status?: number;
	body?: string;
	definitive?: boolean;
}

export class OAuthRefreshError extends Error {
	readonly status?: number;
	readonly body?: string;
	readonly definitive?: boolean;

	constructor(message: string, options: OAuthRefreshErrorOptions = {}) {
		super(message);
		this.name = "OAuthRefreshError";
		this.status = options.status;
		this.body = options.body;
		this.definitive = options.definitive;
	}
}

export function isDefinitiveOAuthRefreshFailure(error: Error): boolean {
	if (error instanceof OAuthRefreshError && error.definitive === true) {
		return true;
	}

	const status = error instanceof OAuthRefreshError ? error.status : undefined;
	if (status === 400 || status === 401) {
		return true;
	}

	const body = error instanceof OAuthRefreshError ? error.body : undefined;
	const text = `${error.message} ${body ?? ""}`.toLowerCase();
	if (text.includes("invalid_grant")) {
		return true;
	}

	return (
		/\b(?:400|401)\b/.test(text) && /\b(?:oauth|refresh|token)\b/.test(text)
	);
}
