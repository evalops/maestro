import { createHash, createPublicKey, verify as verifyBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;
type GithubApiClient = (
	path: string,
	env: Env,
	serverUrl: string | undefined,
) => Promise<unknown>;

interface VerifiedGithubEvidence {
	repository?: string;
	serverUrl?: string;
	runId?: string;
	pullRequestNumber?: number;
	sha?: string;
}

interface PlatformA2ALiveEvidenceVerification {
	path: string;
	evidenceSha256: string;
	protocolVersion: string;
	gitSha: string;
	githubRunId?: string;
	githubPullRequestNumber?: number;
	githubDereferenced?: true;
	negativeAuthProbe?: {
		surface: "platform-agent-registry-peer-discovery";
		errorClass: "unauthorized" | "forbidden";
		rejected: true;
	};
	signature?: {
		algorithm: "ed25519";
		keyId?: string;
		publicKeyFingerprintSha256: string;
		signaturePath: string;
		verified: true;
	};
	delegationId: string;
	a2aTaskId: string;
}

export interface PlatformA2ALiveEvidenceVerificationOptions {
	requireSignature?: boolean;
	requireDereferenceableGithub?: boolean;
	requireNegativeAuthProbe?: boolean;
	publicKeyPem?: string;
	publicKeyPath?: string;
	env?: Env;
	githubApiClient?: GithubApiClient;
}

const PROTOCOL_VERSION = "evalops.maestro.platform-a2a-live-smoke.v1";
const SIGNATURE_PROTOCOL_VERSION =
	"evalops.maestro.platform-a2a-live-evidence-signature.v1";

const VERIFICATION_KEY_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_VERIFY_PUBLIC_KEY",
	"MAESTRO_A2A_LIVE_EVIDENCE_PUBLIC_KEY",
] as const;

const VERIFICATION_KEY_FILE_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_VERIFY_PUBLIC_KEY_FILE",
	"MAESTRO_A2A_LIVE_EVIDENCE_PUBLIC_KEY_FILE",
] as const;

export async function verifyPlatformA2ALiveEvidenceFile(
	evidencePath: string,
	options: PlatformA2ALiveEvidenceVerificationOptions = {},
): Promise<PlatformA2ALiveEvidenceVerification> {
	const evidenceBytes = await readFile(evidencePath, "utf8");
	const sidecar = await readFile(`${evidencePath}.sha256`, "utf8");
	const expectedDigest = parseSidecarDigest(sidecar);
	const actualDigest = sha256Hex(evidenceBytes);
	if (actualDigest !== expectedDigest) {
		throw new Error(
			`Platform A2A evidence digest mismatch for ${evidencePath}: expected ${expectedDigest}, got ${actualDigest}`,
		);
	}
	const evidence = JSON.parse(evidenceBytes) as unknown;
	const record = requireRecord(evidence, "evidence");
	const signature = await verifyDetachedSignature(
		evidencePath,
		evidenceBytes,
		actualDigest,
		options,
	);
	const protocolVersion = requireString(record, "protocolVersion");
	if (protocolVersion !== PROTOCOL_VERSION) {
		throw new Error(
			`unexpected Platform A2A evidence protocol ${protocolVersion}`,
		);
	}
	if (record.live !== true) {
		throw new Error("Platform A2A evidence is not marked live");
	}
	const maestro = requireRecord(record.maestro, "maestro");
	const gitSha = requireString(maestro, "gitSha");
	assertRealishGitSha(gitSha);
	assertNoSyntheticProofId(record);
	const github = verifyGithubEvidence(record.github);
	const githubDereferenced = await verifyDereferenceableGithubEvidence(
		github,
		options,
	);
	const delegation = requireRecord(record.delegation, "delegation");
	const delegationId = requireString(delegation, "id");
	const a2aTaskId = requireString(delegation, "a2aTaskId");
	const inputs = requireRecord(record.inputs, "inputs");
	const fromAgentId = requireString(inputs, "fromAgentId");
	const toAgentId = requireString(inputs, "toAgentId");
	const peers = requireRecord(record.peers, "peers");
	const origin = requireRecord(peers.origin, "peers.origin");
	const target = requireRecord(peers.target, "peers.target");
	const originAgentId = requireString(origin, "agentId");
	const targetAgentId = requireString(target, "agentId");
	if (fromAgentId !== originAgentId) {
		throw new Error(
			`Platform A2A evidence inputs.fromAgentId ${fromAgentId} does not match peers.origin.agentId ${originAgentId}`,
		);
	}
	if (toAgentId !== targetAgentId) {
		throw new Error(
			`Platform A2A evidence inputs.toAgentId ${toAgentId} does not match peers.target.agentId ${targetAgentId}`,
		);
	}
	const graph = requireRecord(record.graph, "graph");
	const nodes = graph.nodes;
	if (!Array.isArray(nodes) || nodes.length < 1) {
		throw new Error("Platform A2A evidence graph has no nodes");
	}
	const graphIncludesDelegation = nodes.some((nodeValue, index) => {
		const node = requireRecord(nodeValue, `graph.nodes[${index}]`);
		return optionalString(node, "delegationId") === delegationId;
	});
	if (!graphIncludesDelegation) {
		throw new Error(
			`Platform A2A evidence graph does not include delegation.id ${delegationId}`,
		);
	}
	const control = requireRecord(record.control, "control");
	requireString(control, "mode");
	const task = requireRecord(record.task, "task");
	const taskId = requireString(task, "id");
	if (taskId !== a2aTaskId) {
		throw new Error(
			`Platform A2A evidence delegation.a2aTaskId ${a2aTaskId} does not match task.id ${taskId}`,
		);
	}
	const controlTaskId = requireString(control, "taskId");
	if (controlTaskId !== taskId) {
		throw new Error(
			`Platform A2A evidence control.taskId ${controlTaskId} does not match task.id ${taskId}`,
		);
	}
	const negativeAuthProbe = verifyNegativeAuthProbe(
		record.negativeAuthProbe,
		options,
	);
	return {
		path: evidencePath,
		evidenceSha256: actualDigest,
		protocolVersion,
		gitSha,
		githubRunId: github?.runId,
		githubPullRequestNumber: github?.pullRequestNumber,
		githubDereferenced,
		negativeAuthProbe,
		signature,
		delegationId,
		a2aTaskId,
	};
}

function verifyNegativeAuthProbe(
	value: unknown,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): PlatformA2ALiveEvidenceVerification["negativeAuthProbe"] | undefined {
	if (value === undefined || value === null) {
		if (options.requireNegativeAuthProbe) {
			throw new Error(
				"Platform A2A evidence requires invalid-token rejection evidence",
			);
		}
		return undefined;
	}
	const probe = requireRecord(value, "negativeAuthProbe");
	const surface = requireString(probe, "surface");
	if (surface !== "platform-agent-registry-peer-discovery") {
		throw new Error(
			`Platform A2A evidence invalid-token probe has unsupported surface: ${surface}`,
		);
	}
	if (probe.rejected !== true) {
		throw new Error(
			"Platform A2A evidence invalid-token probe is not marked rejected",
		);
	}
	const errorClass = requireString(probe, "errorClass");
	if (errorClass !== "unauthorized" && errorClass !== "forbidden") {
		throw new Error(
			`Platform A2A evidence invalid-token probe has unsupported error class: ${errorClass}`,
		);
	}
	requireString(probe, "observedAt");
	return {
		surface,
		errorClass,
		rejected: true,
	};
}

async function verifyDetachedSignature(
	evidencePath: string,
	evidenceBytes: string,
	evidenceDigest: string,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<PlatformA2ALiveEvidenceVerification["signature"] | undefined> {
	const signaturePath = `${evidencePath}.sig.json`;
	const signatureBytes = await readOptionalFile(signaturePath);
	if (!signatureBytes) {
		if (options.requireSignature) {
			throw new Error(
				`Platform A2A evidence requires a detached signature sidecar: ${signaturePath}`,
			);
		}
		return undefined;
	}
	const publicKeyPem = await resolveVerificationPublicKey(options);
	if (!publicKeyPem) {
		if (options.requireSignature) {
			throw new Error(
				"Platform A2A evidence signature verification requires a trusted public key",
			);
		}
		return undefined;
	}
	const signature = requireRecord(
		JSON.parse(signatureBytes) as unknown,
		"signature",
	);
	const protocolVersion = requireString(signature, "protocolVersion");
	if (protocolVersion !== SIGNATURE_PROTOCOL_VERSION) {
		throw new Error(
			`unexpected Platform A2A evidence signature protocol ${protocolVersion}`,
		);
	}
	const algorithm = requireString(signature, "algorithm");
	if (algorithm !== "ed25519") {
		throw new Error(
			`Platform A2A evidence signature algorithm is not supported: ${algorithm}`,
		);
	}
	const signedDigest = requireString(signature, "evidenceSha256");
	if (signedDigest !== evidenceDigest) {
		throw new Error(
			`Platform A2A evidence signature digest mismatch: expected ${evidenceDigest}, got ${signedDigest}`,
		);
	}
	const publicKey = createPublicKey(normalizePem(publicKeyPem));
	if (publicKey.asymmetricKeyType !== "ed25519") {
		throw new Error(
			`Platform A2A evidence verification requires an Ed25519 public key, got ${publicKey.asymmetricKeyType ?? "unknown"}`,
		);
	}
	const expectedFingerprint = fingerprintPublicKeyPem(publicKeyPem);
	const signedFingerprint = requireString(
		signature,
		"publicKeyFingerprintSha256",
	);
	if (signedFingerprint !== expectedFingerprint) {
		throw new Error(
			`Platform A2A evidence signature key fingerprint mismatch: expected ${expectedFingerprint}, got ${signedFingerprint}`,
		);
	}
	const signatureValue = requireString(signature, "signature");
	const ok = verifyBytes(
		null,
		Buffer.from(evidenceBytes),
		publicKey,
		Buffer.from(signatureValue, "base64"),
	);
	if (!ok) {
		throw new Error("Platform A2A evidence detached signature is invalid");
	}
	return {
		algorithm: "ed25519",
		keyId: optionalString(signature, "keyId"),
		publicKeyFingerprintSha256: expectedFingerprint,
		signaturePath,
		verified: true,
	};
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		throw error;
	}
}

async function resolveVerificationPublicKey(
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<string | undefined> {
	if (options.publicKeyPem) {
		return normalizePem(options.publicKeyPem);
	}
	if (options.publicKeyPath) {
		return normalizePem(await readFile(options.publicKeyPath, "utf8"));
	}
	const env = options.env ?? process.env;
	const inlineKey = firstEnv(env, VERIFICATION_KEY_ENV_VARS);
	if (inlineKey) {
		return normalizePem(inlineKey);
	}
	const keyFile = firstEnv(env, VERIFICATION_KEY_FILE_ENV_VARS);
	if (keyFile) {
		return normalizePem(await readFile(keyFile, "utf8"));
	}
	return undefined;
}

function firstEnv(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parseSidecarDigest(sidecar: string): string {
	const digest = sidecar.trim().split(/\s+/u)[0];
	if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
		throw new Error("Platform A2A evidence sidecar does not contain a SHA-256 digest");
	}
	return digest;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Platform A2A evidence field ${name} is not an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Platform A2A evidence field ${key} is missing`);
	}
	return value.trim();
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Platform A2A evidence field ${key} must be a string`);
	}
	return value.trim();
}

function verifyGithubEvidence(
	value: unknown,
): VerifiedGithubEvidence | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const github = requireRecord(value, "github");
	const repository = optionalString(github, "repository");
	if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
		throw new Error(
			`Platform A2A evidence GitHub repository is not owner/repo: ${repository}`,
		);
	}
	const sha = optionalString(github, "sha");
	if (sha) {
		assertRealishGitSha(sha);
	}
	const runId =
		integerStringField(github, "runId") ??
		integerStringField(github, "actionsRunId") ??
		integerStringField(github, "ghaRunId");
	const runUrl = optionalString(github, "runUrl");
	if (runUrl && !/\/actions\/runs\/[1-9]\d*(?:$|[/?#])/u.test(runUrl)) {
		throw new Error(
			`Platform A2A evidence GitHub run URL is not dereferenceable: ${runUrl}`,
		);
	}
	const pullRequestNumber =
		positiveIntegerField(github, "pullRequestNumber") ??
		positiveIntegerField(github, "prNumber") ??
		pullRequestIdentifier(github, "pullRequest") ??
		pullRequestIdentifier(github, "pullRequestRef") ??
		pullRequestIdentifier(github, "pr");
	const pullRequestUrl = optionalString(github, "pullRequestUrl");
	if (pullRequestUrl && !/\/pull\/[1-9]\d*(?:$|[/?#])/u.test(pullRequestUrl)) {
		throw new Error(
			`Platform A2A evidence GitHub PR URL is not dereferenceable: ${pullRequestUrl}`,
		);
	}
	const serverUrl = githubServerUrl(
		optionalString(github, "serverUrl") ??
			githubServerUrlFromWebUrl(runUrl) ??
			githubServerUrlFromWebUrl(pullRequestUrl),
	);
	return { repository, serverUrl, runId, pullRequestNumber, sha };
}

async function verifyDereferenceableGithubEvidence(
	github: VerifiedGithubEvidence | undefined,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<true | undefined> {
	if (!options.requireDereferenceableGithub) {
		return undefined;
	}
	if (!github?.repository) {
		throw new Error(
			"Platform A2A evidence requires dereferenceable GitHub metadata but has no repository",
		);
	}
	if (!github.runId) {
		throw new Error(
			"Platform A2A evidence requires dereferenceable GitHub metadata but has no Actions run id",
		);
	}
	const env = options.env ?? process.env;
	const apiClient = options.githubApiClient ?? defaultGithubApiClient;
	const run = requireRecord(
		await apiClient(
			`/repos/${github.repository}/actions/runs/${github.runId}`,
			env,
			github.serverUrl,
		),
		"github.actionsRun",
	);
	const actualRunId = integerishRecordField(run, "id");
	if (actualRunId !== github.runId) {
		throw new Error(
			`Platform A2A evidence GitHub run id mismatch: expected ${github.runId}, got ${actualRunId}`,
		);
	}
	if (github.pullRequestNumber !== undefined) {
		const pullRequest = requireRecord(
			await apiClient(
				`/repos/${github.repository}/pulls/${github.pullRequestNumber}`,
				env,
				github.serverUrl,
			),
			"github.pullRequest",
		);
		const actualPullRequestNumber = integerishRecordField(pullRequest, "number");
		if (actualPullRequestNumber !== String(github.pullRequestNumber)) {
			throw new Error(
				`Platform A2A evidence GitHub PR number mismatch: expected ${github.pullRequestNumber}, got ${actualPullRequestNumber}`,
			);
		}
	}
	return true;
}

function githubServerUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("unsupported protocol");
		}
		url.hash = "";
		url.search = "";
		url.pathname = url.pathname.replace(/\/+$/u, "");
		return `${url.origin}${url.pathname}`;
	} catch (error) {
		throw new Error(
			`Platform A2A evidence GitHub server URL is invalid: ${value}`,
			{ cause: error },
		);
	}
}

function githubServerUrlFromWebUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return undefined;
		}
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

function githubRestApiBaseUrl(serverUrl: string | undefined): string {
	const normalizedServerUrl = githubServerUrl(serverUrl) ?? "https://github.com";
	if (normalizedServerUrl === "https://github.com") {
		return "https://api.github.com";
	}
	return `${new URL(normalizedServerUrl).origin}/api/v3`;
}

async function defaultGithubApiClient(
	path: string,
	env: Env,
	serverUrl: string | undefined,
): Promise<unknown> {
	const token = firstEnv(env, ["GITHUB_TOKEN", "GH_TOKEN"]);
	const response = await fetch(`${githubRestApiBaseUrl(serverUrl)}${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Platform A2A evidence GitHub dereference failed for ${path}: HTTP ${response.status} ${body.slice(0, 200)}`,
		);
	}
	return await response.json();
}

function integerishRecordField(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = record[key];
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return value.trim();
	}
	throw new Error(`Platform A2A evidence GitHub API field ${key} is not an id`);
}

function integerStringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return value.trim();
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be a positive integer id`,
	);
}

function positiveIntegerField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return Number(value.trim());
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be a positive integer`,
	);
}

function pullRequestIdentifier(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		const numeric = trimmed.match(/^#?([1-9]\d*)$/u);
		if (numeric?.[1]) {
			return Number(numeric[1]);
		}
		const url = trimmed.match(/\/pull\/([1-9]\d*)(?:$|[/?#])/u);
		if (url?.[1]) {
			return Number(url[1]);
		}
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be an integer PR number or /pull/<number> URL`,
	);
}

function assertRealishGitSha(gitSha: string): void {
	if (!/^[a-f0-9]{40}$/u.test(gitSha)) {
		throw new Error(`Platform A2A evidence git SHA is not a 40-hex SHA: ${gitSha}`);
	}
	if (/c0de5afe/u.test(gitSha) || /0{12,}$/u.test(gitSha)) {
		throw new Error(`Platform A2A evidence git SHA looks synthetic: ${gitSha}`);
	}
}

function assertNoSyntheticProofId(record: Record<string, unknown>): void {
	for (const [key, value] of [
		["proofId", record.proofId],
		["evidenceId", record.evidenceId],
	] as const) {
		if (typeof value === "string" && looksLocalProofId(value)) {
			throw new Error(
				`Platform A2A evidence ${key} looks like a local synthetic proof id: ${value}`,
			);
		}
	}
	if (record.proof !== undefined) {
		const proof = requireRecord(record.proof, "proof");
		const id = optionalString(proof, "id");
		if (id && looksLocalProofId(id)) {
			throw new Error(
				`Platform A2A evidence proof.id looks like a local synthetic proof id: ${id}`,
			);
		}
	}
}

function looksLocalProofId(value: string): boolean {
	return /(^|[-_])(local|fixture|replay)([-_]|$)/iu.test(value);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fingerprintPublicKeyPem(publicKeyPem: string): string {
	const publicKey = createPublicKey(normalizePem(publicKeyPem));
	const publicDer = publicKey.export({ format: "der", type: "spki" });
	return createHash("sha256").update(publicDer).digest("hex");
}

function normalizePem(value: string): string {
	return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}

function booleanEnv(value: string | undefined): boolean {
	return value === "1" || value === "true";
}

function isEntrypoint(): boolean {
	const entrypoint = process.argv[1];
	return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isEntrypoint()) {
	const args = process.argv.slice(2);
	const evidencePath =
		args.find((arg) => !arg.startsWith("--"))?.trim() ||
		process.env.MAESTRO_A2A_LIVE_EVIDENCE_PATH?.trim();
	if (!evidencePath) {
		console.error(
			"Usage: tsx scripts/verify-platform-a2a-live-evidence.ts <evidence.json> [--require-signature] [--require-github-dereference] [--require-negative-auth-probe]",
		);
		process.exitCode = 2;
	} else {
		verifyPlatformA2ALiveEvidenceFile(evidencePath, {
			requireDereferenceableGithub:
				args.includes("--require-github-dereference") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_GITHUB_DEREFERENCE,
				),
			requireNegativeAuthProbe:
				args.includes("--require-negative-auth-probe") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_NEGATIVE_AUTH_PROBE,
				),
			requireSignature:
				args.includes("--require-signature") ||
				booleanEnv(process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_SIGNATURE),
		})
			.then((result) => {
				console.log(JSON.stringify(result, null, 2));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(message);
				process.exitCode = 1;
			});
	}
}
