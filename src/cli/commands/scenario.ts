import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_SCENARIO_PACK =
	"evals/scenarios/complex-task-gauntlet.json";

const PACK_SCHEMA_VERSION = "evalops.maestro.scenario-pack.v1";
const REQUIRED_SCENARIO_IDS = new Set([
	"slack-progress-audit",
	"browser-computer-grant-task",
	"github-write-task",
	"deploy-verification-task",
	"memory-conflict-task",
]);
const REQUIRED_COMPLETION_SCHEMA = "evalops.complex_task.slack_completion.v1";
const REQUIRED_EVENT_KINDS = [
	"trigger.accepted",
	"progress",
	"artifact.created",
	"completed",
] as const;

type ScenarioStatus = "completed" | "blocked" | "failed";

interface ScenarioPack {
	schemaVersion: string;
	id: string;
	title: string;
	issue: string;
	entrypoints?: {
		validate?: string;
		run?: string;
	};
	scenarios: Scenario[];
}

interface Scenario {
	id: string;
	title: string;
	prompt: string;
	requiredConnectors: string[];
	inputs: {
		slack?: Record<string, unknown>;
		github?: Record<string, unknown>;
		platformRun?: Record<string, unknown>;
	};
	replay: {
		finalStatus: ScenarioStatus;
		events: ReplayEvent[];
		sideEffects: SideEffect[];
		evidenceLinks: string[];
		blockers?: string[];
	};
	expect: {
		finalStatus: ScenarioStatus;
		requiredEventKinds: string[];
		completionArtifact?: {
			required: boolean;
			schema: string;
			path: string;
		};
		sideEffects: SideEffectExpectation[];
		evidenceLinks: string[];
		blockers?: string[];
		forbiddenFinalText?: string[];
	};
}

interface ReplayEvent {
	kind: string;
	text?: string;
	artifact?: {
		schema?: string;
		path?: string;
	};
}

interface SideEffect {
	kind: string;
	target: string;
	status: string;
}

interface SideEffectExpectation {
	kind: string;
	target: string;
}

interface ScenarioResult {
	id: string;
	status: "passed" | "failed";
	assertions: string[];
	errors: string[];
}

interface ScenarioRunReport {
	schemaVersion: "evalops.maestro.scenario-run-report.v1";
	status: "passed" | "failed";
	scenarioPackId: string;
	results: ScenarioResult[];
}

interface ParsedScenarioArgs {
	action: "validate" | "run" | "help";
	path: string;
	json: boolean;
	junitPath?: string;
	reportPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function parseScenarioStatus(value: unknown): ScenarioStatus | null {
	if (value === "completed" || value === "blocked" || value === "failed") {
		return value;
	}
	return null;
}

function parseSideEffectExpectation(
	value: unknown,
): SideEffectExpectation | null {
	if (!isRecord(value)) return null;
	const kind = asString(value.kind);
	const target = asString(value.target);
	if (!kind || !target) return null;
	return { kind, target };
}

function parseSideEffect(value: unknown): SideEffect | null {
	if (!isRecord(value)) return null;
	const kind = asString(value.kind);
	const target = asString(value.target);
	const status = asString(value.status);
	if (!kind || !target || !status) return null;
	return { kind, target, status };
}

function parseReplayEvent(value: unknown): ReplayEvent | null {
	if (!isRecord(value)) return null;
	const kind = asString(value.kind);
	if (!kind) return null;
	const event: ReplayEvent = {
		kind,
	};
	const text = asString(value.text);
	if (text) {
		event.text = text;
	}
	if (isRecord(value.artifact)) {
		event.artifact = {
			schema: asString(value.artifact.schema),
			path: asString(value.artifact.path),
		};
	}
	return event;
}

function parseScenario(value: unknown): Scenario | null {
	if (!isRecord(value)) return null;
	const id = asString(value.id);
	const title = asString(value.title);
	const prompt = asString(value.prompt);
	const requiredConnectors = asStringArray(value.requiredConnectors);
	const replay = isRecord(value.replay) ? value.replay : undefined;
	const expect = isRecord(value.expect) ? value.expect : undefined;
	if (
		!id ||
		!title ||
		!prompt ||
		requiredConnectors.length === 0 ||
		!replay ||
		!expect
	) {
		return null;
	}
	const replayFinalStatus = parseScenarioStatus(replay.finalStatus);
	const finalStatus = parseScenarioStatus(expect.finalStatus);
	if (!replayFinalStatus || !finalStatus) return null;
	if (!Array.isArray(replay.events)) return null;
	const replayEvents: ReplayEvent[] = [];
	for (const rawEvent of replay.events) {
		const event = parseReplayEvent(rawEvent);
		if (!event) return null;
		replayEvents.push(event);
	}
	if (!Array.isArray(replay.sideEffects)) return null;
	const replaySideEffects: SideEffect[] = [];
	for (const rawSideEffect of replay.sideEffects) {
		const sideEffect = parseSideEffect(rawSideEffect);
		if (!sideEffect) return null;
		replaySideEffects.push(sideEffect);
	}
	if (!Array.isArray(expect.sideEffects)) return null;
	const expectedSideEffects: SideEffectExpectation[] = [];
	for (const rawSideEffect of expect.sideEffects) {
		const sideEffect = parseSideEffectExpectation(rawSideEffect);
		if (!sideEffect) return null;
		expectedSideEffects.push(sideEffect);
	}
	const completionArtifact = isRecord(expect.completionArtifact)
		? {
				required: expect.completionArtifact.required === true,
				schema: asString(expect.completionArtifact.schema) ?? "",
				path: asString(expect.completionArtifact.path) ?? "",
			}
		: undefined;

	return {
		id,
		title,
		prompt,
		requiredConnectors,
		inputs: isRecord(value.inputs) ? value.inputs : {},
		replay: {
			finalStatus: replayFinalStatus,
			events: replayEvents,
			sideEffects: replaySideEffects,
			evidenceLinks: asStringArray(replay.evidenceLinks),
			blockers: asStringArray(replay.blockers),
		},
		expect: {
			finalStatus,
			requiredEventKinds: asStringArray(expect.requiredEventKinds),
			completionArtifact,
			sideEffects: expectedSideEffects,
			evidenceLinks: asStringArray(expect.evidenceLinks),
			blockers: asStringArray(expect.blockers),
			forbiddenFinalText: asStringArray(expect.forbiddenFinalText),
		},
	};
}

function parseScenarioPack(raw: unknown): ScenarioPack | null {
	if (!isRecord(raw)) return null;
	const schemaVersion = asString(raw.schemaVersion);
	const id = asString(raw.id);
	const title = asString(raw.title);
	const issue = asString(raw.issue);
	if (!Array.isArray(raw.scenarios)) return null;
	const scenarios = raw.scenarios.map(parseScenario);
	if (scenarios.some((scenario) => scenario === null)) return null;
	if (!schemaVersion || !id || !title || !issue || scenarios.length === 0) {
		return null;
	}
	const entrypoints = isRecord(raw.entrypoints)
		? {
				validate: asString(raw.entrypoints.validate),
				run: asString(raw.entrypoints.run),
			}
		: undefined;
	return {
		schemaVersion,
		id,
		title,
		issue,
		entrypoints,
		scenarios: scenarios as Scenario[],
	};
}

export async function loadScenarioPack(
	path = DEFAULT_SCENARIO_PACK,
): Promise<ScenarioPack> {
	const absolutePath = resolve(process.cwd(), path);
	const raw = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
	const pack = parseScenarioPack(raw);
	if (!pack) {
		throw new Error(`Scenario pack is malformed: ${path}`);
	}
	return pack;
}

export function validateScenarioPack(pack: ScenarioPack): string[] {
	const failures: string[] = [];
	if (pack.schemaVersion !== PACK_SCHEMA_VERSION) {
		failures.push(`schemaVersion must be ${PACK_SCHEMA_VERSION}`);
	}
	if (
		!pack.issue.startsWith(
			"https://github.com/evalops/maestro-internal/issues/",
		)
	) {
		failures.push("issue must reference evalops/maestro-internal");
	}
	const scenarioIds = new Set(pack.scenarios.map((scenario) => scenario.id));
	for (const scenarioId of REQUIRED_SCENARIO_IDS) {
		if (!scenarioIds.has(scenarioId)) {
			failures.push(`missing required scenario: ${scenarioId}`);
		}
	}
	for (const scenario of pack.scenarios) {
		failures.push(...validateScenario(scenario));
	}
	return failures;
}

function validateScenario(scenario: Scenario): string[] {
	const failures: string[] = [];
	for (const eventKind of REQUIRED_EVENT_KINDS) {
		if (!scenario.expect.requiredEventKinds.includes(eventKind)) {
			failures.push(`${scenario.id}: missing required event kind ${eventKind}`);
		}
	}
	if (scenario.expect.finalStatus === "completed") {
		if (!scenario.expect.completionArtifact?.required) {
			failures.push(
				`${scenario.id}: completed scenarios require completion artifact`,
			);
		}
		if (
			scenario.expect.completionArtifact?.schema !== REQUIRED_COMPLETION_SCHEMA
		) {
			failures.push(
				`${scenario.id}: completion artifact schema must be ${REQUIRED_COMPLETION_SCHEMA}`,
			);
		}
	}
	if (
		scenario.requiredConnectors.includes("browser") ||
		scenario.requiredConnectors.includes("computer")
	) {
		for (const connector of ["browser", "computer"]) {
			if (!scenario.requiredConnectors.includes(connector)) continue;
			const hasGrantSideEffect = scenario.expect.sideEffects.some(
				(effect) =>
					effect.kind === "grant.reviewed" && effect.target === connector,
			);
			if (!hasGrantSideEffect) {
				failures.push(
					`${scenario.id}: ${connector} scenarios must assert grant.reviewed:${connector}`,
				);
			}
		}
	}
	if (scenario.expect.evidenceLinks.length === 0) {
		failures.push(`${scenario.id}: expected evidence links are required`);
	}
	if (scenario.expect.sideEffects.length === 0) {
		failures.push(`${scenario.id}: expected side effects are required`);
	}
	if (
		scenario.expect.finalStatus === "blocked" &&
		(scenario.expect.blockers?.length ?? 0) === 0
	) {
		failures.push(`${scenario.id}: blocked scenarios require blockers`);
	}
	return failures;
}

export function runScenarioPack(pack: ScenarioPack): ScenarioRunReport {
	const validationFailures = validateScenarioPack(pack);
	if (validationFailures.length > 0) {
		return {
			schemaVersion: "evalops.maestro.scenario-run-report.v1",
			status: "failed",
			scenarioPackId: pack.id,
			results: [
				{
					id: "pack-validation",
					status: "failed",
					assertions: [],
					errors: validationFailures,
				},
			],
		};
	}

	const results = pack.scenarios.map(runScenario);
	return {
		schemaVersion: "evalops.maestro.scenario-run-report.v1",
		status: results.every((result) => result.status === "passed")
			? "passed"
			: "failed",
		scenarioPackId: pack.id,
		results,
	};
}

function runScenario(scenario: Scenario): ScenarioResult {
	const assertions: string[] = [];
	const errors: string[] = [];
	const events = scenario.replay.events;
	const eventKinds = events.map((event) => event.kind);
	if (scenario.replay.finalStatus !== scenario.expect.finalStatus) {
		errors.push(
			`${scenario.id}: final status mismatch, expected ${scenario.expect.finalStatus} but replay ended ${scenario.replay.finalStatus}`,
		);
	} else {
		assertions.push(`final-status:${scenario.expect.finalStatus}`);
	}
	for (const requiredKind of scenario.expect.requiredEventKinds) {
		if (!eventKinds.includes(requiredKind)) {
			errors.push(`${scenario.id}: missing event ${requiredKind}`);
		} else {
			assertions.push(`event:${requiredKind}`);
		}
	}
	const acceptedIndex = eventKinds.indexOf("trigger.accepted");
	const completedIndex = eventKinds.indexOf("completed");
	if (
		acceptedIndex >= 0 &&
		completedIndex >= 0 &&
		acceptedIndex > completedIndex
	) {
		errors.push(`${scenario.id}: trigger.accepted must precede completed`);
	}
	if (scenario.expect.completionArtifact?.required) {
		const artifactIndex = events.findIndex(
			(event) =>
				event.kind === "artifact.created" &&
				event.artifact?.schema === scenario.expect.completionArtifact?.schema &&
				event.artifact?.path === scenario.expect.completionArtifact?.path,
		);
		const artifact =
			artifactIndex >= 0 ? events[artifactIndex]?.artifact : undefined;
		if (artifactIndex < 0) {
			errors.push(`${scenario.id}: completion artifact schema mismatch`);
		} else if (artifact) {
			assertions.push(`artifact-schema:${artifact.schema}`);
			assertions.push(`artifact-path:${artifact.path}`);
		}
		if (
			artifactIndex >= 0 &&
			completedIndex >= 0 &&
			artifactIndex > completedIndex
		) {
			errors.push(`${scenario.id}: artifact.created must precede completed`);
		}
	}
	for (const expectedEffect of scenario.expect.sideEffects) {
		const matched = scenario.replay.sideEffects.some(
			(effect) =>
				effect.kind === expectedEffect.kind &&
				effect.target === expectedEffect.target &&
				effect.status === "observed",
		);
		if (!matched) {
			errors.push(
				`${scenario.id}: missing side effect ${expectedEffect.kind}:${expectedEffect.target}`,
			);
		} else {
			assertions.push(
				`side-effect:${expectedEffect.kind}:${expectedEffect.target}`,
			);
		}
	}
	for (const evidenceLink of scenario.expect.evidenceLinks) {
		if (!scenario.replay.evidenceLinks.includes(evidenceLink)) {
			errors.push(`${scenario.id}: missing evidence link ${evidenceLink}`);
		} else {
			assertions.push(`evidence:${evidenceLink}`);
		}
	}
	for (const blocker of scenario.expect.blockers ?? []) {
		if (!scenario.replay.blockers?.includes(blocker)) {
			errors.push(`${scenario.id}: missing blocker ${blocker}`);
		} else {
			assertions.push(`blocker:${blocker}`);
		}
	}
	const finalText =
		[...events].reverse().find((event) => event.kind === "completed")?.text ??
		"";
	for (const forbidden of scenario.expect.forbiddenFinalText ?? []) {
		if (finalText.toLowerCase().includes(forbidden.toLowerCase())) {
			errors.push(
				`${scenario.id}: final text includes forbidden term ${forbidden}`,
			);
		}
	}
	return {
		id: scenario.id,
		status: errors.length === 0 ? "passed" : "failed",
		assertions,
		errors,
	};
}

function parseScenarioArgs(args: string[]): ParsedScenarioArgs {
	const [firstArg, ...rest] = args;
	const action =
		firstArg === "validate" || firstArg === "run" || firstArg === "help"
			? firstArg
			: "help";
	let path = DEFAULT_SCENARIO_PACK;
	let json = false;
	let junitPath: string | undefined;
	let reportPath: string | undefined;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--json") {
			json = true;
		} else if (arg === "--junit") {
			junitPath = rest[index + 1];
			index++;
		} else if (arg === "--report") {
			reportPath = rest[index + 1];
			index++;
		} else if (arg && !arg.startsWith("-")) {
			path = arg;
		}
	}
	return {
		action,
		path,
		json,
		junitPath,
		reportPath,
	};
}

export async function handleScenarioCommand(args: string[]): Promise<void> {
	const parsed = parseScenarioArgs(args);
	if (parsed.action === "help") {
		printScenarioHelp();
		return;
	}
	const pack = await loadScenarioPack(parsed.path);
	if (parsed.action === "validate") {
		const failures = validateScenarioPack(pack);
		const summary = {
			ok: failures.length === 0,
			scenarioPackId: pack.id,
			scenarioCount: pack.scenarios.length,
			failures,
		};
		if (parsed.json) {
			console.log(JSON.stringify(summary, null, 2));
		} else if (failures.length === 0) {
			console.log(
				`Scenario pack valid: ${pack.id} (${pack.scenarios.length} scenarios)`,
			);
		} else {
			console.error("Scenario pack invalid:");
			for (const failure of failures) {
				console.error(`- ${failure}`);
			}
		}
		if (failures.length > 0) {
			process.exitCode = 1;
		}
		return;
	}

	const report = runScenarioPack(pack);
	if (parsed.reportPath) {
		await writeJson(parsed.reportPath, report);
	}
	if (parsed.junitPath) {
		await writeText(parsed.junitPath, renderJUnit(report));
	}
	if (parsed.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(
			`Scenario run ${report.status}: ${report.scenarioPackId} (${report.results.length} scenarios)`,
		);
		for (const result of report.results) {
			console.log(`- ${result.status}: ${result.id}`);
			for (const error of result.errors) {
				console.log(`  ${error}`);
			}
		}
	}
	if (report.status !== "passed") {
		process.exitCode = 1;
	}
}

function printScenarioHelp(): void {
	console.log(`Usage:
  maestro scenario validate [pack.json] [--json]
  maestro scenario run [pack.json] [--json] [--junit junit.xml] [--report report.json]

Default pack:
  ${DEFAULT_SCENARIO_PACK}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
	const absolutePath = resolve(process.cwd(), path);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, value, "utf8");
}

function renderJUnit(report: ScenarioRunReport): string {
	const tests = report.results.length;
	const failures = report.results.filter(
		(result) => result.status === "failed",
	).length;
	const cases = report.results
		.map((result) => {
			const failureBody =
				result.errors.length > 0
					? `<failure message="${escapeXml(result.errors[0] ?? "failed")}">${escapeXml(result.errors.join("\n"))}</failure>`
					: "";
			const assertions = escapeXml(result.assertions.join("\n"));
			return `  <testcase classname="maestro.scenario" name="${escapeXml(result.id)}">${failureBody}<system-out>${assertions}</system-out></testcase>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeXml(report.scenarioPackId)}" tests="${tests}" failures="${failures}">
${cases}
</testsuite>
`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
