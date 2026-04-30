import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listMaestroTimelineWithPlatform } from "../src/platform/maestro-timeline-client.js";

const GO_SERVER = String.raw`
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	agentruntimev1 "github.com/evalops/platform/gen/go/agentruntime/v1"
	approvalsv1 "github.com/evalops/platform/gen/go/approvals/v1"
	"github.com/evalops/platform/gen/go/maestro/v1/maestrov1connect"
	toolexecutionv1 "github.com/evalops/platform/gen/go/toolexecution/v1"
	"github.com/evalops/platform/internal/agentruntime/agentruntime"
	"github.com/evalops/platform/internal/approvals/approvals"
	auditevents "github.com/evalops/platform/internal/audit/events"
	"github.com/evalops/platform/internal/maestro/timeline"
	"github.com/evalops/platform/internal/toolexecution/toolexecution"
	"github.com/evalops/platform/pkg/authmw"
	"github.com/evalops/platform/pkg/connectkit"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	ctx := context.Background()
	base := time.Date(2026, 4, 30, 18, 0, 0, 0, time.UTC)
	runtimeStore := agentruntime.NewMemoryStore()
	toolStore := toolexecution.NewMemoryStore()
	approvalStore := approvals.NewMemoryStore()
	auditStore := auditevents.NewStore()

	run := &agentruntimev1.AgentRun{
		Id: "run_1",
		Trigger: &agentruntimev1.NormalizedTrigger{
			WorkspaceId:    "ws_1",
			AgentId:        "maestro",
			ChannelId:      "maestro-session:session_1",
			IdempotencyKey: "maestro-session:ws_1:session_1",
		},
		Linkage: &agentruntimev1.AgentRunLinkage{
			RunId:       "run_1",
			WorkspaceId: "ws_1",
			AgentId:     "maestro",
			ObjectiveId: "obj_1",
		},
		CreatedAt: timestamppb.New(base),
		UpdatedAt: timestamppb.New(base),
	}
	_, _, _, err := runtimeStore.CreateRun(ctx, run, []*agentruntimev1.RuntimeEvent{
		{
			Id:         "evt_wait",
			Type:       agentruntimev1.RuntimeEventType_RUNTIME_EVENT_TYPE_RUN_WAITING,
			Message:    "waiting for approval",
			OccurredAt: timestamppb.New(base.Add(2 * time.Minute)),
			WaitId:     "wait_1",
		},
	})
	must(err)

	approvalRequest := approvals.ApprovalRequestRecord{
		ID:             "approval_1",
		WorkspaceID:    "ws_1",
		ApproverUserID: "manager_1",
		AgentID:        "maestro",
		Surface:        "maestro",
		ActionType:     "run governed shell command",
		RiskLevel:      approvalsv1.RiskLevel_RISK_LEVEL_HIGH,
		State:          "pending",
		CreatedAt:      base.Add(time.Minute),
		UpdatedAt:      base.Add(time.Minute),
		ExpiresAt:      base.Add(time.Hour),
	}
	_, err = approvalStore.CreateApprovalRequest(ctx, approvalRequest)
	must(err)
	_, _, _, err = approvalStore.FinalizeApproval(ctx, "approval_1", approvals.ApprovalDecisionRecord{
		ID:                "decision_1",
		ApprovalRequestID: "approval_1",
		Decision:          approvalsv1.DecisionType_DECISION_TYPE_APPROVED,
		DecidedBy:         "manager_1",
		Reason:            "approved by smoke harness",
		DecidedAt:         base.Add(3 * time.Minute),
	}, "resolved", false, 0)
	must(err)

	execution := &toolexecutionv1.ToolExecution{
		Id: "texec_1",
		Linkage: &toolexecutionv1.ToolExecutionLinkage{
			WorkspaceId:    "ws_1",
			OrganizationId: "org_1",
			AgentId:        "maestro",
			RunId:          "run_1",
			ObjectiveId:    "obj_1",
			StepId:         "step_1",
			CorrelationId:  "corr_1",
		},
		Tool: &toolexecutionv1.ToolRef{
			Namespace:  "shell",
			Name:       "npm test",
			Capability: "command",
		},
		IdempotencyKey: "tool_idem_1",
		State:          toolexecutionv1.ToolExecutionState_TOOL_EXECUTION_STATE_WAITING_APPROVAL,
		ApprovalWait: &toolexecutionv1.ToolApprovalWait{
			Id:                "wait_tool_1",
			ApprovalRequestId: "approval_1",
			ResumeToken:       "resume_1",
			CreatedAt:         timestamppb.New(base.Add(time.Minute)),
		},
		CreatedAt: timestamppb.New(base.Add(time.Minute)),
		UpdatedAt: timestamppb.New(base.Add(time.Minute)),
	}
	_, _, err = toolStore.CreateExecution(ctx, execution, &toolexecutionv1.ExecuteToolRequest{
		Linkage:        execution.GetLinkage(),
		Tool:           execution.GetTool(),
		IdempotencyKey: "tool_idem_1",
	})
	must(err)

	_, err = auditStore.Append(auditevents.Event{
		Timestamp:      base.Add(4 * time.Minute),
		OrganizationID: "org_1",
		WorkspaceID:    "ws_1",
		Surface:        "maestro",
		Action:         "maestro.events.tool_call.completed",
		Resource:       auditevents.Resource{Type: "tool_call", ID: "tool_call_1"},
		Outcome:        "success",
		Classification: "internal",
		Metadata: map[string]any{
			"maestro_event_type": "maestro.events.tool_call.completed",
			"session_id":         "session_1",
			"agent_run_id":       "run_1",
			"tool_call_id":       "tool_call_1",
			"tool_execution_id":  "texec_1",
			"summary":            "npm test completed successfully",
		},
	})
	must(err)

	service := timeline.NewService(
		timeline.WithRuntimeStore(runtimeStore),
		timeline.WithToolExecutionStore(toolStore),
		timeline.WithApprovalStore(approvalStore),
		timeline.WithAuditStore(auditStore),
	)
	path, handler := maestrov1connect.NewMaestroTimelineServiceHandler(service, connectkit.StandardHandlerOptions()...)
	principal := authmw.Principal{
		OrganizationID: "org_1",
		WorkspaceID:    "ws_1",
		Subject:        "user_1",
		Scopes:         []string{"maestro:timeline:read", "maestro:timeline:audit"},
		IsHuman:        true,
	}
	mux := http.NewServeMux()
	mux.Handle(path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := authmw.ContextWithPrincipal(r.Context(), principal)
		handler.ServeHTTP(w, r.WithContext(ctx))
	}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	fmt.Printf("PLATFORM_TIMELINE_URL=http://%s\n", listener.Addr().String())
	_ = os.Stdout.Sync()
	must(http.Serve(listener, mux))
}
`;

function resolvePlatformRepo(): string {
	const configured =
		process.env.MAESTRO_PLATFORM_REPO?.trim() ||
		process.env.PLATFORM_REPO?.trim();
	if (configured) {
		return resolve(configured);
	}
	return resolve(process.cwd(), "..", "platform");
}

async function waitForServer(
	child: ReturnType<typeof spawn>,
): Promise<string> {
	return await new Promise((resolveUrl, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			reject(new Error(`timed out waiting for Platform server: ${output}`));
		}, 30_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const match = output.match(/PLATFORM_TIMELINE_URL=(http:\/\/[^\s]+)/u);
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
					`Platform timeline server exited before readiness code=${code} signal=${signal}: ${output}`,
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
	await Promise.race([
		exited,
		new Promise((resolve) => setTimeout(resolve, 5_000)),
	]);
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
	const tempDir = mkdtempSync(join(platformRepo, ".tmp-maestro-timeline-e2e-"));
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
		const timeline = await listMaestroTimelineWithPlatform(
			{
				baseUrl,
				token: "smoke",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 5_000,
				maxAttempts: 1,
			},
			{
				sessionId: "session_1",
				agentRunId: "run_1",
				remoteRunnerSessionId: "rrs_1",
				pendingRequestCount: 0,
				includeAuditOnly: true,
			},
		);
		const types = new Set(timeline.items.map((item) => item.type));
		assert(timeline.platformBacked, "timeline was not marked Platform-backed");
		assert(timeline.source === "platform", "timeline source was not Platform");
		assert(types.has("wait.pending"), "missing wait.pending from Platform timeline");
		assert(
			types.has("tool.completed"),
			"missing tool.completed from Platform audit event",
		);
		assert(
			timeline.items.some(
				(item) => item.type === "policy.decision" && item.status === "approved",
			),
			"missing approved Platform approval decision",
		);
		assert(
			timeline.items.some(
				(item) =>
					item.toolExecutionId === "texec_1" &&
					item.approvalRequestId === "approval_1" &&
					item.platformOperation === "ResumeToolExecution",
			),
			"missing ToolExecution approval correlation",
		);
		assert(
			timeline.items.some(
				(item) =>
					item.remoteRunnerSessionId === "rrs_1" ||
					item.metadata?.agentRunId === "run_1",
			),
			"missing run or remote-runner correlation",
		);
		console.log(
			`Validated Maestro timeline client against live Platform handler at ${baseUrl} (${timeline.items.length} entries)`,
		);
	} finally {
		await terminateChild(child, exited);
		rmSync(tempDir, { recursive: true, force: true });
	}
}

await main();
