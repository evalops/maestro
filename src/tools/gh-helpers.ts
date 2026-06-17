import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "../agent/types.js";
import { checkCommand } from "../safety/execpolicy.js";
import { requirePlanCheck } from "../safety/safe-mode.js";
import type { Sandbox } from "../sandbox/types.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { resolveShellEnvironment } from "../utils/shell-env.js";
import { type BashBackgroundDetails, bashTool } from "./bash.js";
import { killProcessTree } from "./shell-utils.js";

const GH_TIMEOUT_MS = 90_000;
const GH_MAX_BUFFER = 40 * 1024;
const GH_SANDBOX_MAX_BUFFER = GH_MAX_BUFFER + 1;

type OutputCapture = {
	text: string;
	bytes: number;
	truncated: boolean;
	decoder: StringDecoder;
};

function createOutputCapture(): OutputCapture {
	return {
		text: "",
		bytes: 0,
		truncated: false,
		decoder: new StringDecoder("utf8"),
	};
}

function appendCapturedOutput(capture: OutputCapture, data: Buffer): void {
	if (capture.bytes >= GH_MAX_BUFFER) {
		capture.truncated = true;
		return;
	}

	const remainingBytes = GH_MAX_BUFFER - capture.bytes;
	if (data.length <= remainingBytes) {
		capture.text += capture.decoder.write(data);
		capture.bytes += data.length;
		return;
	}

	capture.text += capture.decoder.write(data.subarray(0, remainingBytes));
	capture.bytes = GH_MAX_BUFFER;
	capture.truncated = true;
}

function finalizeCapturedOutput(capture: OutputCapture): string {
	if (!capture.truncated) {
		capture.text += capture.decoder.end();
	}
	return capture.text;
}

function quotePolicyArg(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildGhPolicyCommand(args: string[]): string {
	return ["gh", ...args].map(quotePolicyArg).join(" ");
}

function isMutatingGhCommand(args: string[]): boolean {
	const [resource, action] = args;
	if (resource === "pr") {
		return action === "create" || action === "checkout" || action === "comment";
	}
	if (resource === "issue") {
		return action === "create" || action === "comment" || action === "close";
	}
	if (resource === "repo") {
		return action === "clone" || action === "fork";
	}
	return false;
}

function ghCliNotInstalledResult(): AgentToolResult<
	BashBackgroundDetails | undefined
> {
	return {
		content: [
			{
				type: "text",
				text: `GitHub CLI (gh) is not installed.

Install it with:
  macOS:   brew install gh
  Linux:   See https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  Windows: See https://cli.github.com

After installing, authenticate with: gh auth login`,
			},
		],
		isError: true,
		details: undefined,
	};
}

function sandboxRequiresArgvResult(): AgentToolResult<
	BashBackgroundDetails | undefined
> {
	return {
		content: [
			{
				type: "text",
				text: "Sandbox gh checks require argv-capable sandbox support.",
			},
		],
		isError: true,
		details: undefined,
	};
}
function sandboxGhProbeFailureResult(
	text: string,
): AgentToolResult<BashBackgroundDetails | undefined> | null {
	if (
		!text.includes("Command timed out") &&
		!text.includes("Command cancelled") &&
		!text.includes("Daytona session command timed out")
	) {
		return null;
	}
	return {
		content: [
			{
				type: "text",
				text: sanitizeWithStaticMask(text).trim(),
			},
		],
		isError: true,
		details: undefined,
	};
}

function sandboxGhProbeLooksLikeMissingGh(text: string): boolean {
	const normalizedText = text.toLowerCase();
	return (
		normalizedText.includes("gh: command not found") ||
		normalizedText.includes(
			"gh is not recognized as an internal or external command",
		) ||
		normalizedText.includes(
			"'gh' is not recognized as an internal or external command",
		) ||
		normalizedText.includes(
			'"gh" is not recognized as an internal or external command',
		) ||
		normalizedText.includes("spawn gh enoent") ||
		normalizedText.includes("exec: gh: executable file not found") ||
		normalizedText.includes('exec: "gh": executable file not found') ||
		normalizedText.includes("exec: 'gh': executable file not found")
	);
}

function sandboxGhAvailabilityFailureResult(
	text: string,
): AgentToolResult<BashBackgroundDetails | undefined> {
	return {
		content: [
			{
				type: "text",
				text: `GitHub CLI availability check failed.

Original error:
${sanitizeWithStaticMask(text).trim() || "Unknown sandbox gh probe failure"}`,
			},
		],
		isError: true,
		details: undefined,
	};
}

function sandboxGhProbeLooksLikeAuthIssue(text: string): boolean {
	const normalizedText = text.toLowerCase();
	return (
		normalizedText.includes("http 401") ||
		normalizedText.includes("http 403") ||
		normalizedText.includes("bad credentials") ||
		normalizedText.includes("authentication failed") ||
		normalizedText.includes("invalid token") ||
		normalizedText.includes("token is no longer valid") ||
		normalizedText.includes("token has expired")
	);
}

function sandboxGhAuthenticationFailureResult(
	text: string,
): AgentToolResult<BashBackgroundDetails | undefined> {
	return {
		content: [
			{
				type: "text",
				text: `GitHub CLI authentication check failed.

Original error:
${sanitizeWithStaticMask(text).trim() || "Unknown sandbox gh auth probe failure"}`,
			},
		],
		isError: true,
		details: undefined,
	};
}

function combineAbortSignals(signals: AbortSignal[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abortFrom = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of signals) {
		if (signal.aborted) {
			abortFrom(signal);
			break;
		}
		const listener = () => abortFrom(signal);
		listeners.push({ signal, listener });
		signal.addEventListener("abort", listener, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}

async function runSandboxGhProbe(
	sandbox: Sandbox,
	args: string[],
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ isError: boolean; text: string } | null> {
	if (!sandbox.execWithArgs) {
		return null;
	}
	if (signal?.aborted) {
		return {
			isError: true,
			text: "Command cancelled",
		};
	}

	const timeoutController = new AbortController();
	let timedOut = false;
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, GH_TIMEOUT_MS);
	const combinedSignal = signal
		? combineAbortSignals([signal, timeoutController.signal])
		: { signal: timeoutController.signal, cleanup: () => {} };
	let abortProbe: (() => void) | undefined;

	try {
		const probeAbortPromise = new Promise<never>((_, reject) => {
			abortProbe = () => reject(new Error("Sandbox gh probe aborted"));
			if (combinedSignal.signal.aborted) {
				abortProbe();
				return;
			}
			combinedSignal.signal.addEventListener("abort", abortProbe, {
				once: true,
			});
		});
		const result = await Promise.race([
			sandbox.execWithArgs("gh", args, {
				env,
				maxBuffer: GH_SANDBOX_MAX_BUFFER,
				signal: combinedSignal.signal,
			}),
			probeAbortPromise,
		]);
		const messages = [result.stdout, result.stderr].filter(Boolean);
		if (signal?.aborted) {
			messages.push("Command cancelled");
		} else if (timedOut) {
			messages.push(`Command timed out after ${GH_TIMEOUT_MS / 1000}s`);
		}
		return {
			isError: timedOut || signal?.aborted || result.exitCode !== 0,
			text: messages.join("\n"),
		};
	} catch (error) {
		if (signal?.aborted) {
			return {
				isError: true,
				text: "Command cancelled",
			};
		}
		if (timedOut) {
			return {
				isError: true,
				text: `Command timed out after ${GH_TIMEOUT_MS / 1000}s`,
			};
		}
		throw error;
	} finally {
		clearTimeout(timeoutHandle);
		if (abortProbe) {
			combinedSignal.signal.removeEventListener("abort", abortProbe);
		}
		combinedSignal.cleanup();
	}
}

/**
 * Check if GitHub CLI is installed and authenticated.
 * Returns an error result if not available, otherwise returns null.
 */
export async function checkGhCliAvailable(
	signal?: AbortSignal,
	sandbox?: Sandbox,
): Promise<AgentToolResult<BashBackgroundDetails | undefined> | null> {
	const sandboxEnv = sandbox
		? resolveShellEnvironment(undefined, { workspaceDir: process.cwd() })
		: undefined;

	if (sandbox) {
		const checkResult = await runSandboxGhProbe(
			sandbox,
			["--version"],
			sandboxEnv ?? {},
			signal,
		);
		if (!checkResult) {
			return sandboxRequiresArgvResult();
		}
		if (checkResult.isError) {
			const probeFailure = sandboxGhProbeFailureResult(checkResult.text);
			if (probeFailure) {
				return probeFailure;
			}
			if (sandboxGhProbeLooksLikeMissingGh(checkResult.text)) {
				return ghCliNotInstalledResult();
			}
			return sandboxGhAvailabilityFailureResult(checkResult.text);
		}
	} else {
		// Check if gh CLI is installed
		const checkResult = await bashTool.execute(
			"gh-check",
			{ command: "which gh" },
			signal,
		);

		const checkContent = checkResult.content[0];
		const checkText =
			checkContent && "text" in checkContent ? checkContent.text : "";
		if (
			checkResult.isError ||
			checkText.includes("Command failed") ||
			checkText.includes("Exit code:")
		) {
			return ghCliNotInstalledResult();
		}
	}

	let authText = "";
	let sandboxAuthProbeErrored = false;
	if (sandbox) {
		const authCheck = await runSandboxGhProbe(
			sandbox,
			["auth", "status"],
			sandboxEnv ?? {},
			signal,
		);
		if (!authCheck) {
			return sandboxRequiresArgvResult();
		}
		sandboxAuthProbeErrored = authCheck.isError;
		if (sandboxAuthProbeErrored) {
			const probeFailure = sandboxGhProbeFailureResult(authCheck.text);
			if (probeFailure) {
				return probeFailure;
			}
		}
		authText = authCheck.text;
	} else {
		// Check if authenticated by running a simple gh command
		const authCheck = await bashTool.execute(
			"gh-auth-check",
			{ command: "gh auth status" },
			signal,
		);

		const authContent = authCheck.content[0];
		authText = authContent && "text" in authContent ? authContent.text : "";
	}

	if (
		authText.includes("not logged in") ||
		authText.includes("gh auth login") ||
		authText.includes("You are not logged into any")
	) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub CLI is not authenticated.

Please run: gh auth login

This will open a browser to authenticate with GitHub.
You can also use a personal access token: gh auth login --with-token`,
				},
			],
			isError: true,
			details: undefined,
		};
	}

	if (sandboxAuthProbeErrored) {
		if (!sandboxGhProbeLooksLikeAuthIssue(authText)) {
			return sandboxGhAvailabilityFailureResult(authText);
		}
		return sandboxGhAuthenticationFailureResult(authText);
	}

	return null; // All checks passed
}

/**
 * Execute a gh CLI command with automatic error handling for common issues.
 */
export async function executeGhCommand(
	toolCallId: string,
	args: string[],
	signal?: AbortSignal,
	sandbox?: Sandbox,
): Promise<AgentToolResult<BashBackgroundDetails | undefined>> {
	const result = await executeGhArgv(toolCallId, args, signal, sandbox);

	const resultContent = result.content[0];
	const text =
		resultContent && "text" in resultContent ? resultContent.text : "";

	// Check for common errors and provide helpful messages
	if (text.includes("not logged in") || text.includes("gh auth login")) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub CLI is not authenticated.

Please run: gh auth login

Original error:
${text}`,
				},
			],
			isError: result.isError,
			details: undefined,
		};
	}

	if (text.includes("not found") && text.includes("repository")) {
		return {
			content: [
				{
					type: "text",
					text: `Not in a git repository with GitHub remote.

Make sure you're in a git repository that has a GitHub remote configured.
Check with: git remote -v

Original error:
${text}`,
				},
			],
			isError: result.isError,
			details: undefined,
		};
	}

	if (text.includes("GraphQL") && text.includes("Could not resolve to")) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub resource not found.

This usually means:
- The PR/issue number doesn't exist
- You don't have access to this repository
- The repository/organization doesn't exist

Original error:
${text}`,
				},
			],
			isError: result.isError,
			details: undefined,
		};
	}

	return result;
}

async function executeGhArgv(
	_toolCallId: string,
	args: string[],
	signal?: AbortSignal,
	sandbox?: Sandbox,
): Promise<AgentToolResult<BashBackgroundDetails | undefined>> {
	const policyCommand = buildGhPolicyCommand(args);
	const policyResult = checkCommand(policyCommand, process.cwd());
	if (policyResult.decision === "forbidden") {
		const matchInfo = policyResult.matchedRules
			.map((rule) =>
				rule.type === "prefix"
					? `prefix: ${rule.matchedPrefix.join(" ")}`
					: `heuristic: ${rule.command.join(" ")}`,
			)
			.join(", ");
		return {
			content: [
				{
					type: "text",
					text: `Command blocked by execpolicy: ${policyCommand}\n\nDecision: forbidden\nMatched rules: ${matchInfo || "none"}\n\nTo allow this command, add a prefix_rule to .maestro/execpolicy`,
				},
			],
			isError: true,
			details: undefined,
		};
	}

	if (isMutatingGhCommand(args)) {
		requirePlanCheck("gh");
	}

	if (signal?.aborted) {
		throw new Error("GitHub CLI command aborted before start");
	}

	if (sandbox) {
		return executeGhInSandbox(policyCommand, args, sandbox, signal);
	}

	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: true,
			env: resolveShellEnvironment(undefined, {
				workspaceDir: process.cwd(),
			}),
			...(signal ? { signal } : {}),
		});
		const stdoutCapture = createOutputCapture();
		const stderrCapture = createOutputCapture();
		let timedOut = false;
		let aborted = false;
		const buildResult = (
			exitCode?: number | null,
		): AgentToolResult<BashBackgroundDetails | undefined> => {
			let output = finalizeCapturedOutput(stdoutCapture);
			const stderr = finalizeCapturedOutput(stderrCapture);
			if (stderr) {
				if (output) output += "\n";
				output += stderr;
			}
			const truncationMessages: string[] = [];
			if (stdoutCapture.truncated) {
				const displayedKB = Math.round(GH_MAX_BUFFER / 1024);
				truncationMessages.push(
					`stdout exceeded ${displayedKB}KB limit and was truncated`,
				);
			}
			if (stderrCapture.truncated) {
				const displayedKB = Math.round(GH_MAX_BUFFER / 1024);
				truncationMessages.push(
					`stderr exceeded ${displayedKB}KB limit and was truncated`,
				);
			}
			if (truncationMessages.length > 0) {
				output += `\n\n⚠️ Output truncated: ${truncationMessages.join("; ")}. Consider narrowing the gh query or requesting fewer fields.`;
			}
			if (timedOut) {
				output += `\n\n⏱️ Command timed out after ${GH_TIMEOUT_MS / 1000}s`;
			} else if (aborted) {
				output += "\n\nCommand cancelled";
			} else if (exitCode !== 0) {
				output += `\n\nExit code: ${exitCode}`;
			}

			return {
				content: [
					{
						type: "text",
						text:
							sanitizeWithStaticMask(output).trim() ||
							"Command executed successfully (no output)",
					},
				],
				isError: timedOut || aborted || exitCode !== 0,
				details: undefined,
			};
		};

		const onAbort = () => {
			if (child.pid) {
				killProcessTree(child.pid);
				return;
			}
			child.kill("SIGTERM");
		};
		const onSignalAbort = () => {
			aborted = true;
			onAbort();
		};
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			onAbort();
		}, GH_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timeoutHandle);
			if (signal) {
				signal.removeEventListener("abort", onSignalAbort);
			}
		};
		if (signal) {
			signal.addEventListener("abort", onSignalAbort, { once: true });
			if (signal.aborted) {
				onSignalAbort();
			}
		}

		child.stdout?.on("data", (data) => {
			appendCapturedOutput(stdoutCapture, Buffer.from(data));
		});
		child.stderr?.on("data", (data) => {
			appendCapturedOutput(stderrCapture, Buffer.from(data));
		});
		child.on("error", (error) => {
			cleanup();
			if ((error as { code?: string }).code === "ENOENT") {
				resolve(ghCliNotInstalledResult());
				return;
			}
			if (signal?.aborted || aborted) {
				aborted = true;
				resolve(buildResult());
				return;
			}
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			resolve(buildResult(code));
		});
	});
}

async function executeGhInSandbox(
	command: string,
	args: string[],
	sandbox: Sandbox,
	signal?: AbortSignal,
): Promise<AgentToolResult<BashBackgroundDetails | undefined>> {
	const stdoutCapture = createOutputCapture();
	const stderrCapture = createOutputCapture();
	let timedOut = false;
	let aborted = false;

	const buildResult = (exitCode?: number) => {
		if (signal?.aborted) {
			aborted = true;
		}
		let output = finalizeCapturedOutput(stdoutCapture);
		const stderr = finalizeCapturedOutput(stderrCapture);
		if (stderr) {
			if (output) output += "\n";
			output += stderr;
		}
		const truncationMessages: string[] = [];
		if (stdoutCapture.truncated) {
			const displayedKB = Math.round(GH_MAX_BUFFER / 1024);
			truncationMessages.push(
				`stdout exceeded ${displayedKB}KB limit and was truncated`,
			);
		}
		if (stderrCapture.truncated) {
			const displayedKB = Math.round(GH_MAX_BUFFER / 1024);
			truncationMessages.push(
				`stderr exceeded ${displayedKB}KB limit and was truncated`,
			);
		}
		if (truncationMessages.length > 0) {
			output += `\n\n⚠️ Output truncated: ${truncationMessages.join("; ")}. Consider narrowing the gh query or requesting fewer fields.`;
		}
		if (timedOut) {
			output += `\n\n⏱️ Command timed out after ${GH_TIMEOUT_MS / 1000}s`;
		} else if (aborted) {
			output += "\n\nCommand cancelled";
		} else if (exitCode !== undefined && exitCode !== 0) {
			output += `\n\nExit code: ${exitCode}`;
		}

		return {
			content: [
				{
					type: "text" as const,
					text:
						sanitizeWithStaticMask(output).trim() ||
						"Command executed successfully (no output)",
				},
			],
			isError:
				timedOut || aborted || (exitCode !== undefined && exitCode !== 0),
			details: undefined,
		};
	};

	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, GH_TIMEOUT_MS);
	const onSignalAbort = () => {
		aborted = true;
	};
	if (signal) {
		signal.addEventListener("abort", onSignalAbort, { once: true });
		if (signal.aborted) {
			onSignalAbort();
		}
	}
	let cleanupCombinedSignal = () => {};
	let combinedSandboxSignal: AbortSignal | undefined;
	let abortExec: (() => void) | undefined;

	try {
		const env = resolveShellEnvironment(undefined, {
			workspaceDir: process.cwd(),
		});
		if (!sandbox.execWithArgs) {
			return {
				content: [
					{
						type: "text",
						text: "Sandbox gh execution requires argv-capable sandbox support.",
					},
				],
				isError: true,
				details: undefined,
			};
		}
		const combinedSignal = signal
			? combineAbortSignals([signal, timeoutController.signal])
			: { signal: timeoutController.signal, cleanup: () => {} };
		combinedSandboxSignal = combinedSignal.signal;
		cleanupCombinedSignal = combinedSignal.cleanup;
		const execAbortPromise = new Promise<never>((_, reject) => {
			abortExec = () => reject(new Error("Sandbox gh command aborted"));
			if (aborted || combinedSignal.signal.aborted) {
				abortExec();
				return;
			}
			combinedSignal.signal.addEventListener("abort", abortExec, {
				once: true,
			});
		});
		const result = await Promise.race([
			sandbox.execWithArgs("gh", args, {
				env,
				maxBuffer: GH_SANDBOX_MAX_BUFFER,
				signal: combinedSignal.signal,
			}),
			execAbortPromise,
		]);
		appendCapturedOutput(stdoutCapture, Buffer.from(result.stdout));
		appendCapturedOutput(stderrCapture, Buffer.from(result.stderr));
		return buildResult(result.exitCode);
	} catch (error) {
		const execError = error as {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
		};
		if (typeof execError.stdout === "string") {
			appendCapturedOutput(stdoutCapture, Buffer.from(execError.stdout));
		}
		if (typeof execError.stderr === "string") {
			appendCapturedOutput(stderrCapture, Buffer.from(execError.stderr));
		}
		if (timedOut || aborted) {
			return buildResult();
		}
		throw error;
	} finally {
		clearTimeout(timeoutHandle);
		if (abortExec && combinedSandboxSignal) {
			combinedSandboxSignal.removeEventListener("abort", abortExec);
		}
		cleanupCombinedSignal();
		if (signal) {
			signal.removeEventListener("abort", onSignalAbort);
		}
	}
}
