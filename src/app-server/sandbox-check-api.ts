import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MaestroAppServerSandboxCheckMode,
	MaestroAppServerSandboxCheckResult,
	MaestroAppServerSandboxProbeResult,
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

export class MaestroAppServerSandboxCheckError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerSandboxCheckError";
	}
}

export interface MaestroAppServerSandboxCheck {
	probe(): MaestroAppServerSandboxProbeResult;
	runCheck(params?: UnknownRecord): Promise<MaestroAppServerSandboxCheckResult>;
}

export interface MaestroAppServerSandboxCheckOptions {
	cwd?: string;
	isNativeSandboxAvailable?: () => boolean;
	getNativeSandboxType?: () => MaestroAppServerSandboxType;
	createSandbox?: (
		options: CreateSandboxOptions,
	) => Promise<Sandbox | undefined>;
}

function parseCheckMode(value: unknown): MaestroAppServerSandboxCheckMode {
	if (value === undefined || value === null) {
		return "workspace-write";
	}
	if (value === "read-only" || value === "workspace-write") {
		return value;
	}
	throw new MaestroAppServerSandboxCheckError(-32602, "Invalid sandbox mode");
}

export function normalizeSandboxCheckParams(value: unknown): UnknownRecord {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new MaestroAppServerSandboxCheckError(-32602, "Invalid params");
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
): MaestroAppServerSandboxCheckResult["checks"][number] {
	return { name, passed, detail };
}

export function createMaestroAppServerSandboxCheck(
	options: MaestroAppServerSandboxCheckOptions = {},
): MaestroAppServerSandboxCheck {
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
				checkAvailable: isAvailable,
			};
		},

		async runCheck(params = {}) {
			const normalizedParams = normalizeSandboxCheckParams(params);
			const mode = parseCheckMode(normalizedParams.mode);
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
				`maestro-native-check-outside-${process.pid}-${Date.now()}`,
			);
			let workspace: string | undefined;
			let sandbox: Sandbox | undefined;
			const checks: MaestroAppServerSandboxCheckResult["checks"] = [];
			try {
				workspace = mkdtempSync(join(cwd, "maestro-native-check-"));
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
						"touch inside-check.txt && test -f inside-check.txt",
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
						"touch read-only-check.txt 2>/dev/null",
					);
					checks.push(
						checkDetail(
							"read-only-write-blocked",
							readOnly.exitCode !== 0 &&
								!existsSync(join(workspace, "read-only-check.txt")),
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
						"native-sandbox-check",
						false,
						error instanceof Error ? error.message : "check failed",
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
