/**
 * Swarm validation directive
 *
 * Builds the "## Validation" section handed to every swarm teammate. The
 * default posture is end-to-end validation against real integrations: a worker
 * may not declare a task done on the strength of a mocked path. Mocks/stubs are
 * an explicit per-task opt-out (`SwarmTask.mocksAllowed`), not the baseline.
 *
 * This mirrors the orchestrator discipline that high-end coding agents apply at
 * the mission level, pushed down to the per-worker delegation prompt so the
 * default holds even for a single delegated task.
 */

const REAL_INTEGRATION_DIRECTIVE =
	"Validate end-to-end against real integrations. The default is that every change is exercised through its real execution path — real services, real data, real auth — before you finish. Do not introduce mocks or stubs to make a check pass. Add or update focused tests when behavior changes, and run the relevant verification (build, lint, the touched tests, and the real end-to-end path) before reporting completion. If an integration genuinely cannot be exercised in this environment, stop and report it as a blocker rather than claiming success — never report that something works on the strength of a mocked path alone.";

const MOCKS_ALLOWED_DIRECTIVE =
	"This task is explicitly approved to use mocks or stubs where a real integration is unavailable. Prefer the real execution path wherever it exists; where you fall back to a mock, say so explicitly and name exactly what was not exercised for real. Add or update focused tests when behavior changes, and run the relevant verification before reporting completion.";

/**
 * Returns the validation directive for a swarm task.
 *
 * @param mocksAllowed When true, the task has explicitly opted out of the
 *   real-integration default and may use mocks/stubs for unavailable
 *   dependencies.
 */
export function buildSwarmValidationDirective(mocksAllowed?: boolean): string {
	return mocksAllowed ? MOCKS_ALLOWED_DIRECTIVE : REAL_INTEGRATION_DIRECTIVE;
}
