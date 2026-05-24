import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MaestroAppServerSandboxProbeResult,
	MaestroAppServerSandboxProofMode,
	MaestroAppServerSandboxProofResult,
	MaestroAppServerSandboxType,
} from "@evalops/contracts";
import {
	type CreateSandboxOptions,
	type Sandbox,
	createSandbox,
	getNativeSandboxType,
	isNativeSandboxAvailable,
} from "../sandbox/index.js";

type UnknownRecord = Record<string, unknown>;

export class MaestroAppServerSandboxProofError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerSandboxProofError";
	}
}

export interface MaestroAppServerSandboxProof {
	probe(): MaestroAppServerSandboxProbeResult;
	runProof(params?: UnknownRecord): Promise<MaestroAppServerSandboxProofResult>;
}

export interface MaestroAppServerSandboxProofOptions {
	cwd?: string;
	isNativeSandboxAvailable?: () => boolean;
	getNativeSandboxType?: () => MaestroAppServerSandboxType;
	createSandbox?: (
		options: CreateSandboxOptions,
	) => Promise<Sandbox | undefined>;
}

function parseProofMode(value: unknown): MaestroAppServerSandboxProofMode {
	if (value === undefined || value === null) {
		return "workspace-write";
	}
	if (value === "read-only" || value === "workspace-write") {
		return value;
	}
	throw new MaestroAppServerSandboxProofError(-32602, "Invalid sandbox mode");
}

export function normalizeSandboxProofParams(value: unknown): UnknownRecord {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new MaestroAppServerSandboxProofError(-32602, "Invalid params");
	}
	return value as UnknownRecord;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function checkDetail(
	name: string,
	passed: boolean,
	detail: string,
): MaestroAppServerSandboxProofResult["checks"][number] {
	return { name, passed, detail };
}

export function createMaestroAppServerSandboxProof(
	options: MaestroAppServerSandboxProofOptions = {},
): MaestroAppServerSandboxProof {
	const available =
		options.isNativeSandboxAvailable ?? isNativeSandboxAvailable;
	const sandboxType = options.getNativeSandboxType ?? getNativeSandboxType;
	const sandboxFactory = options.createSandbox ?? createSandbox;
	const cwd = options.cwd ?? process.cwd();

	return {
		probe() {
			const isAvailable = available();
			return {
				available: isAvailable,
				type: sandboxType(),
				platform: osPlatform(),
				supportedModes: isAvailable ? ["read-only", "workspace-write"] : [],
				proofAvailable: isAvailable,
			};
		},

		async runProof(params = {}) {
			const normalizedParams = normalizeSandboxProofParams(params);
			const mode = parseProofMode(normalizedParams.mode);
			const type = sandboxType();
			if (!available()) {
				return {
					mode,
					available: false,
					type,
					passed: false,
					skippedReason: "Native sandbox is not available on this platform.",
					checks: [],
				};
			}

			const outsidePath = join(
				tmpdir(),
				`maestro-native-proof-outside-${process.pid}-${Date.now()}`,
			);
			let workspace: string | undefined;
			let sandbox: Sandbox | undefined;
			const checks: MaestroAppServerSandboxProofResult["checks"] = [];
			try {
				workspace = mkdtempSync(join(cwd, "maestro-native-proof-"));
				sandbox = await sandboxFactory({
					mode,
					cwd: workspace,
					native: {
						policy: mode,
						networkAccess: false,
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
				});
				if (!sandbox) {
					checks.push(
						checkDetail(
							"native-sandbox-instance",
							false,
							"No sandbox instance was created.",
						),
					);
					return { mode, available: true, type, passed: false, checks };
				}

				const envMarker = await sandbox.exec('printf "%s" "$MAESTRO_SANDBOX"');
				checks.push(
					checkDetail(
						"native-env-marker",
						envMarker.exitCode === 0 && envMarker.stdout.trim() === type,
						`MAESTRO_SANDBOX=${envMarker.stdout.trim() || "(empty)"}`,
					),
				);

				if (mode === "workspace-write") {
					const inside = await sandbox.exec(
						"touch inside-proof.txt && test -f inside-proof.txt",
					);
					checks.push(
						checkDetail(
							"workspace-write",
							inside.exitCode === 0,
							inside.exitCode === 0
								? "wrote inside workspace"
								: inside.stderr || inside.stdout || "inside write failed",
						),
					);
				} else {
					const readOnly = await sandbox.exec(
						"touch read-only-proof.txt 2>/dev/null",
					);
					checks.push(
						checkDetail(
							"read-only-write-blocked",
							readOnly.exitCode !== 0 &&
								!existsSync(join(workspace, "read-only-proof.txt")),
							readOnly.exitCode !== 0
								? "blocked workspace write"
								: "workspace write unexpectedly succeeded",
						),
					);
				}

				const outside = await sandbox.exec(
					`touch ${shellQuote(outsidePath)} 2>/dev/null`,
				);
				checks.push(
					checkDetail(
						"outside-write-blocked",
						outside.exitCode !== 0 && !existsSync(outsidePath),
						outside.exitCode !== 0
							? "blocked write outside workspace"
							: "outside write unexpectedly succeeded",
					),
				);

				return {
					mode,
					available: true,
					type,
					passed: checks.every((check) => check.passed),
					checks,
				};
			} catch (error) {
				checks.push(
					checkDetail(
						"native-sandbox-proof",
						false,
						error instanceof Error ? error.message : "proof failed",
					),
				);
				return { mode, available: true, type, passed: false, checks };
			} finally {
				await sandbox?.dispose();
				if (workspace) {
					rmSync(workspace, { recursive: true, force: true });
				}
				rmSync(outsidePath, { force: true });
			}
		},
	};
}
