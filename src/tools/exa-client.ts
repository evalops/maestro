const EXA_API_BASE = "https://api.exa.ai";

interface ExaErrorResponse {
	error?: {
		message?: string;
		type?: string;
	};
	message?: string;
}

function getExaApiKey(): string {
	const apiKey = process.env.EXA_API_KEY;
	if (!apiKey) {
		throw new Error(
			"EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys",
		);
	}
	return apiKey;
}

function parseErrorMessage(rawBody: string): string | undefined {
	if (!rawBody) return undefined;
	try {
		const parsed = JSON.parse(rawBody) as ExaErrorResponse;
		return parsed.error?.message ?? parsed.message ?? rawBody;
	} catch {
		return rawBody;
	}
}

export async function callExa<T>(endpoint: string, body: unknown): Promise<T> {
	const apiKey = getExaApiKey();
	const response = await fetch(`${EXA_API_BASE}${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		const message = parseErrorMessage(responseBody) ?? response.statusText;
		throw new Error(
			`Exa API error (${response.status}): ${message.trim() || response.statusText}`,
		);
	}

	if (!responseBody) {
		return {} as T;
	}

	try {
		return JSON.parse(responseBody) as T;
	} catch (error) {
		throw new Error(
			`Failed to parse Exa response: ${(error as Error).message}`,
		);
	}
}
