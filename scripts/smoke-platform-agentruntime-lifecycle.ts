import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PlatformAgentRunStateValue,
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	PlatformRuntimeEventTypeValue,
	buildMaestroSessionRuntimeTrigger,
	claimNextAgentRuntimeRun,
	completeAgentRuntimeRun,
	getAgentRuntimeRun,
	handleAgentRuntimeTrigger,
	listAgentRuntimeRunEvents,
	recordAgentRuntimeRunStep,
	resumeAgentRuntimeRun,
	waitAgentRuntimeRun,
} from "../src/platform/agent-runtime-client.js";
import { resolvePlatformRepo } from "./platform-smoke-repo.js";

const GO_SERVER = String.raw`
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"

	agentruntimev1 "github.com/evalops/platform/gen/go/agentruntime/v1"
	"github.com/evalops/platform/gen/go/agentruntime/v1/agentruntimev1connect"
	agentsv1 "github.com/evalops/platform/gen/go/agents/v1"
	objectivesv1 "github.com/evalops/platform/gen/go/objectives/v1"
	"github.com/evalops/platform/internal/agentruntime/agentruntime"
	"github.com/evalops/platform/pkg/connectkit"
)

type fakeRegistry struct{}

func (fakeRegistry) ResolveAgentConfig(_ context.Context, trigger agentruntime.TriggerContext) (*agentsv1.Agent, *agentsv1.AgentConfig, error) {
	workspaceID := trigger.Trigger.GetWorkspaceId()
	agentID := trigger.Trigger.GetAgentId()
	return &agentsv1.Agent{
			Id:                  agentID,
			WorkspaceId:         workspaceID,
			Status:              agentsv1.AgentStatus_AGENT_STATUS_ACTIVE,
			ActiveConfigVersion: 1,
		}, &agentsv1.AgentConfig{
			AgentId: agentID,
			Version: 1,
		}, nil
}

type fakeObjectives struct{}

func (fakeObjectives) ResolveActiveObjective(_ context.Context, trigger agentruntime.TriggerContext) (*objectivesv1.Objective, error) {
	return &objectivesv1.Objective{
		Id:          "objective_1",
		WorkspaceId: trigger.Trigger.GetWorkspaceId(),
		AgentId:     trigger.Trigger.GetAgentId(),
		Title:       "Maestro governed tool smoke",
		State:       objectivesv1.ObjectiveState_OBJECTIVE_STATE_RUNNING,
	}, nil
}

type recordingWorker struct{}

func (recordingWorker) DispatchAgentRun(context.Context, *agentruntimev1.AgentRun) (*agentruntime.DispatchResult, error) {
	return &agentruntime.DispatchResult{
		Queue:       "runs.default",
		ReferenceID: "maestro-smoke-dispatch",
		Attributes:  map[string]string{"worker": "maestro-smoke"},
	}, nil
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	service := agentruntime.NewService(
		agentruntime.NewMemoryStore(),
		agentruntime.WithClients(agentruntime.ClientSet{
			Registry:   fakeRegistry{},
			Objectives: fakeObjectives{},
			Worker:     recordingWorker{},
		}),
	)
	path, handler := agentruntimev1connect.NewAgentRuntimeServiceHandler(service, connectkit.StandardHandlerOptions()...)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	fmt.Printf("PLATFORM_AGENTRUNTIME_URL=http://%s\n", listener.Addr().String())
	_ = os.Stdout.Sync()
	must(http.Serve(listener, mux))
}
`;

async function waitForServer(child: ReturnType<typeof spawn>): Promise<string> {
	return await new Promise((resolveUrl, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			reject(new Error(`timed out waiting for Platform server: ${output}`));
		}, 30_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const match = output.match(/PLATFORM_AGENTRUNTIME_URL=(http:\/\/[^\s]+)/u);
			if (match?.[1]) {
				clearTimeout(timeout);
				resolveUrl(match[1]);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`Platform AgentRuntime server exited before readiness code=${code} signal=${signal}: ${output}`,
				),
			);
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function terminateChild(
	child: ReturnType<typeof spawn>,
	exited: Promise<void>,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const killProcessGroup = process.platform !== "win32" && child.pid;
	if (killProcessGroup) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill();
		}
	} else {
		child.kill();
	}
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		try {
			if (killProcessGroup) {
				process.kill(-child.pid, "SIGKILL");
			} else {
				child.kill("SIGKILL");
			}
		} catch {
			child.kill("SIGKILL");
		}
		await Promise.race([
			exited,
			new Promise((resolve) => setTimeout(resolve, 1_000)),
		]);
	}
}

async function main(): Promise<void> {
	const platformRepo = resolvePlatformRepo();
	const tempDir = mkdtempSync(
		join(platformRepo, ".tmp-maestro-agentruntime-e2e-"),
	);
	writeFileSync(join(tempDir, "main.go"), GO_SERVER, "utf8");
	const child = spawn("go", ["run", "."], {
		cwd: tempDir,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
	try {
		const baseUrl = await waitForServer(child);
		const config = {
			baseUrl,
			token: "smoke",
			organizationId: "org_1",
			workspaceId: "ws_1",
			timeoutMs: 5_000,
			maxAttempts: 1,
		};
		const trigger = buildMaestroSessionRuntimeTrigger(
			{
				workspaceId: "ws_1",
				sessionId: "session_1",
				actorId: "user_1",
				metadata: {
					path: "agentruntime.lifecycle",
					tool: "shell.echo",
				},
			},
			"ws_1",
		);
		assert(trigger, "failed to build Maestro session trigger");
		const triggerResult = await handleAgentRuntimeTrigger(trigger, { config });
		const runId = triggerResult.run.id;
		assert(runId, "Platform returned no run id");

		const firstClaim = await claimNextAgentRuntimeRun(
			{
				workerId: "maestro-smoke-worker-1",
				workerQueue: "runs.default",
				leaseSeconds: 30,
			},
			{ config },
		);
		assert(
			firstClaim.run.state === PlatformAgentRunStateValue.Running,
			`first claim state ${firstClaim.run.state}`,
		);
		const firstLeaseToken = firstClaim.lease?.token ?? firstClaim.run.lease?.token;
		assert(firstLeaseToken, "first claim did not return a lease token");

		await recordAgentRuntimeRunStep(
			{
				runId,
				leaseToken: firstLeaseToken,
				step: {
					id: "step_tool_1",
					name: "governed shell echo",
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
				},
			},
			{ config },
		);
		const waiting = await waitAgentRuntimeRun(
			{
				runId,
				leaseToken: firstLeaseToken,
				wait: {
					id: "wait_approval_1",
					stepId: "step_tool_1",
					type: PlatformAgentRunWaitTypeValue.Approval,
					externalRef: "approval_1",
					reason: "governed tool call requires approval",
					payload: {
						toolExecutionId: "texec_1",
						command: "echo platform-governed-tool",
					},
				},
				checkpoint: {
					id: "checkpoint_approval_1",
					stepId: "step_tool_1",
					resumeToken: "resume-after-approval",
					payload: { cursor: "after-tool-approval" },
				},
			},
			{ config },
		);
		assert(
			waiting.run.state === PlatformAgentRunStateValue.Waiting,
			`waiting state ${waiting.run.state}`,
		);
		assert(
			waiting.wait?.externalRef === "approval_1",
			"approval wait was not recorded",
		);

		await resumeAgentRuntimeRun(
			{
				runId,
				waitId: "wait_approval_1",
				resumeEventId: "approval_event_1",
				payload: { decision: "approved" },
			},
			{ config },
		);
		const secondClaim = await claimNextAgentRuntimeRun(
			{
				workerId: "maestro-smoke-worker-2",
				workerQueue: "runs.default",
				leaseSeconds: 30,
			},
			{ config },
		);
		const secondLeaseToken =
			secondClaim.lease?.token ?? secondClaim.run.lease?.token;
		assert(secondLeaseToken, "second claim did not return a lease token");

		await recordAgentRuntimeRunStep(
			{
				runId,
				leaseToken: secondLeaseToken,
				step: {
					id: "step_tool_1",
					name: "governed shell echo",
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Succeeded,
					output: { text: "platform-governed-tool" },
				},
			},
			{ config },
		);
		const completed = await completeAgentRuntimeRun(
			{
				runId,
				leaseToken: secondLeaseToken,
				result: { status: "ok", toolExecutionId: "texec_1" },
			},
			{ config },
		);
		assert(
			completed.run.state === PlatformAgentRunStateValue.Succeeded,
			`completed state ${completed.run.state}`,
		);

		const finalRun = await getAgentRuntimeRun({ runId }, { config });
		const eventList = await listAgentRuntimeRunEvents({ runId }, { config });
		const eventTypes = new Set(eventList.events.map((event) => event.type));
		assert(finalRun.run.steps?.length === 1, "final run is missing tool step");
		assert(finalRun.run.waits?.length === 1, "final run is missing approval wait");
		assert(
			eventTypes.has(PlatformRuntimeEventTypeValue.RunWaiting),
			"runtime events are missing the approval wait",
		);
		assert(
			eventTypes.has(PlatformRuntimeEventTypeValue.RunSucceeded),
			"runtime events are missing run completion",
		);
		console.log(
			`Validated Maestro AgentRuntime lifecycle against live Platform handler at ${baseUrl} (run ${runId}, ${eventList.events.length} events)`,
		);
	} finally {
		await terminateChild(child, exited);
		rmSync(tempDir, { recursive: true, force: true });
	}
}

await main();
