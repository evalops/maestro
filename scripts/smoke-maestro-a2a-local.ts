import { once } from "node:events";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	buildA2AUserMessage,
	discoverA2AAgentCard,
	getA2ATask,
	resolveA2AServiceConfig,
	sendA2AMessage,
} from "../src/platform/a2a-client.js";

const SMOKE_RESPONSE = "A2A smoke response from Maestro Rust TUI agent";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("failed to allocate a local TCP port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return port;
}

async function waitForHealth(baseUrl: string, stderr: () => string): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) {
				return;
			}
		} catch {
			// The Rust server may still be compiling or binding the port.
		}
		await delay(100);
	}
	throw new Error(`Rust control-plane did not become ready:\n${stderr()}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), delay(2_000)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
}

async function main(): Promise<void> {
	const port = await openPort();
	const baseUrl = `http://127.0.0.1:${port}`;
	let stderr = "";
	const controlPlane = spawn(
		"cargo",
		[
			"run",
			"--quiet",
			"--manifest-path",
			"packages/control-plane-rs/Cargo.toml",
			"--bin",
			"maestro-control-plane",
		],
		{
			env: {
				...process.env,
				MAESTRO_A2A_AGENT_NAME: "Maestro Rust TUI Smoke Agent",
				MAESTRO_A2A_FAKE_RESPONSE: SMOKE_RESPONSE,
				MAESTRO_CONTROL_HOST: "127.0.0.1",
				MAESTRO_WEB_REQUIRE_KEY: "0",
				PORT: String(port),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	controlPlane.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	try {
		await waitForHealth(baseUrl, () => stderr);
		const config = await resolveA2AServiceConfig({
			baseUrl,
			workspaceId: "local-a2a-smoke",
			agentId: "maestro-ts-tui-smoke",
			sessionId: "a2a-smoke-session",
			actorId: "maestro-ts-tui",
			timeoutMs: 1_500,
			maxAttempts: 1,
		});
		if (!config) {
			throw new Error("failed to resolve local A2A config");
		}

		const card = await discoverA2AAgentCard(config);
		if (card.name !== "Maestro Rust TUI Smoke Agent") {
			throw new Error(`unexpected A2A agent card name: ${card.name}`);
		}

		const sent = await sendA2AMessage(config, {
			message: buildA2AUserMessage({
				text: "Reply with the deterministic A2A smoke response.",
				messageId: `ts-to-rust-${Date.now()}`,
				contextId: "a2a-smoke-session",
			}),
			configuration: {
				acceptedOutputModes: ["text/plain"],
				returnImmediately: false,
			},
		});
		const task = await getA2ATask(config, sent.task.id);
		const artifactText = task.artifacts
			?.flatMap((artifact) => artifact.parts.map((part) => part.text ?? ""))
			.join("\n")
			.trim();
		if (task.status.state !== "TASK_STATE_COMPLETED") {
			throw new Error(`unexpected A2A task state: ${task.status.state}`);
		}
		if (artifactText !== SMOKE_RESPONSE) {
			throw new Error(`unexpected A2A artifact text: ${artifactText ?? "<empty>"}`);
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					card: card.name,
					taskId: task.id,
					contextId: task.contextId,
					state: task.status.state,
				},
				null,
				2,
			),
		);
	} finally {
		await stopProcess(controlPlane);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
