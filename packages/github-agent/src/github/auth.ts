import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GitHubAuthConfig {
	token?: string;
	appId?: string;
	appPrivateKey?: string;
	appPrivateKeyPath?: string;
	appInstallationId?: number;
	apiUrl?: string;
	owner?: string;
	repo?: string;
	userAgent?: string;
}

export type GitHubToken = {
	token: string;
	type: "pat" | "app";
	expiresAt?: string;
};

export interface GitHubAuthProvider {
	getToken(): Promise<GitHubToken>;
	getAppJwt?(): Promise<string>;
}

type InstallationTokenResponse = {
	token: string;
	expires_at: string;
};

type InstallationLookupResponse = {
	id: number;
};

const DEFAULT_API_URL = "https://api.github.com";
const JWT_TTL_SECONDS = 9 * 60;
const JWT_SKEW_SECONDS = 30;
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

export function resolveGitHubApiUrl(explicit?: string): string {
	const envUrl = process.env.GITHUB_API_URL;
	const base = explicit ?? envUrl ?? DEFAULT_API_URL;
	return base.replace(/\/$/, "");
}

export function resolveGitHubGraphqlUrl(apiUrl: string): string {
	if (apiUrl.endsWith("/api/v3")) {
		return `${apiUrl.replace(/\/api\/v3$/, "")}/api/graphql`;
	}
	return `${apiUrl}/graphql`;
}

export class GitHubAuth implements GitHubAuthProvider {
	private readonly apiUrl: string;
	private readonly userAgent: string;
	private readonly token?: string;
	private readonly appId?: string;
	private readonly appPrivateKey?: string;
	private readonly appInstallationId?: number;
	private cachedAppJwt?: { token: string; expiresAtMs: number };
	private cachedInstallationToken?: GitHubToken;
	private cachedInstallationExpiry?: number;
	private resolvedInstallationId?: number;
	private readonly owner?: string;
	private readonly repo?: string;

	constructor(config: GitHubAuthConfig) {
		this.apiUrl = resolveGitHubApiUrl(config.apiUrl);
		this.userAgent = config.userAgent ?? "evalops-github-agent";
		this.token = config.token;
		this.appId = config.appId;
		this.appInstallationId = config.appInstallationId;
		this.owner = config.owner;
		this.repo = config.repo;
		const key = config.appPrivateKey ?? this.loadKeyFromPath(config);
		this.appPrivateKey = key ? normalizePrivateKey(key) : undefined;
	}

	async getToken(): Promise<GitHubToken> {
		if (this.token) {
			return { token: this.token, type: "pat" };
		}
		if (!this.appId || !this.appPrivateKey) {
			throw new Error(
				"GitHub auth requires either GITHUB_TOKEN or GitHub App credentials",
			);
		}
		return this.getInstallationToken();
	}

	async getAppJwt(): Promise<string> {
		if (!this.appId || !this.appPrivateKey) {
			throw new Error("GitHub App credentials are not configured");
		}
		const now = Date.now();
		if (this.cachedAppJwt && now < this.cachedAppJwt.expiresAtMs) {
			return this.cachedAppJwt.token;
		}
		const jwt = createAppJwt(this.appId, this.appPrivateKey);
		const expiresAtMs = Math.floor(Date.now() / 1000 + JWT_TTL_SECONDS) * 1000;
		this.cachedAppJwt = { token: jwt, expiresAtMs };
		return jwt;
	}

	private loadKeyFromPath(config: GitHubAuthConfig): string | undefined {
		const path = config.appPrivateKeyPath;
		if (!path) return undefined;
		const resolved = resolve(path);
		if (!existsSync(resolved)) {
			throw new Error(`GitHub App private key not found at ${resolved}`);
		}
		return readFileSync(resolved, "utf8");
	}

	private async getInstallationToken(): Promise<GitHubToken> {
		const now = Date.now();
		if (
			this.cachedInstallationToken &&
			this.cachedInstallationExpiry &&
			now + TOKEN_REFRESH_SKEW_MS < this.cachedInstallationExpiry
		) {
			return this.cachedInstallationToken;
		}
		const installationId = await this.resolveInstallationId();
		const jwt = await this.getAppJwt();
		const response = await fetch(
			`${this.apiUrl}/app/installations/${installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": this.userAgent,
				},
			},
		);
		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to create installation token (${response.status}): ${text}`,
			);
		}
		const data = (await response.json()) as InstallationTokenResponse;
		const token: GitHubToken = {
			token: data.token,
			type: "app",
			expiresAt: data.expires_at,
		};
		this.cachedInstallationToken = token;
		this.cachedInstallationExpiry = Date.parse(data.expires_at);
		return token;
	}

	private async resolveInstallationId(): Promise<number> {
		if (this.appInstallationId) {
			return this.appInstallationId;
		}
		if (this.resolvedInstallationId) {
			return this.resolvedInstallationId;
		}
		if (!this.owner || !this.repo) {
			throw new Error(
				"owner/repo is required to resolve GitHub App installation id",
			);
		}
		const jwt = await this.getAppJwt();
		const response = await fetch(
			`${this.apiUrl}/repos/${this.owner}/${this.repo}/installation`,
			{
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": this.userAgent,
				},
			},
		);
		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to resolve installation id (${response.status}): ${text}`,
			);
		}
		const data = (await response.json()) as InstallationLookupResponse;
		this.resolvedInstallationId = data.id;
		return data.id;
	}
}

function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iat: now - JWT_SKEW_SECONDS,
		exp: now + JWT_TTL_SECONDS,
		iss: appId,
	};
	const header = { alg: "RS256", typ: "JWT" };
	const encodedHeader = base64UrlEncode(JSON.stringify(header));
	const encodedPayload = base64UrlEncode(JSON.stringify(payload));
	const unsigned = `${encodedHeader}.${encodedPayload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsigned);
	signer.end();
	const signature = signer.sign(createPrivateKey(privateKey));
	return `${unsigned}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | Buffer): string {
	const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function normalizePrivateKey(value: string): string {
	const trimmed = value.trim();
	if (trimmed.includes("-----BEGIN")) {
		return trimmed.replace(/\\n/g, "\n");
	}
	const decoded = decodeBase64Maybe(trimmed);
	if (decoded.includes("-----BEGIN")) {
		return decoded;
	}
	return trimmed.replace(/\\n/g, "\n");
}

function decodeBase64Maybe(value: string): string {
	try {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		return decoded.includes("-----BEGIN") ? decoded : value;
	} catch {
		return value;
	}
}
