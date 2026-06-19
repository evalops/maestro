import { existsSync, readdirSync } from "node:fs";
import chalk from "chalk";
import {
	getMissionArtifactLayout,
	initializeMissionArtifacts,
	summarizeMissionSnapshot,
	validateMissionArtifactContent,
} from "../../agent/mission-artifacts.js";
import {
	MISSION_MANIFEST_VERSION,
	type MissionManifest,
} from "../../agent/mission-manifest.js";
import {
	type MissionState,
	MissionStore,
	type MissionStoreSnapshot,
	getMissionStatePath,
	listMissionStoreSnapshots,
} from "../../agent/mission-store.js";
import { readJsonFile, readTextFile, writeJsonFile } from "../../utils/fs.js";

export async function handleMissionCommand(
	subcommand: string | undefined,
	args: readonly string[],
	options: { json?: boolean } = {},
): Promise<void> {
	switch (subcommand ?? "status") {
		case "init":
			handleMissionInit(args, options);
			return;
		case "status":
			handleMissionStatus(args, options);
			return;
		case "record":
			handleMissionRecord(args, options);
			return;
		case "set-state":
			handleMissionSetState(args, options);
			return;
		case "validate":
			handleMissionValidate(args, options);
			return;
		default:
			throw new Error(
				`Unknown mission subcommand: ${subcommand}. Use init, status, record, set-state, or validate.`,
			);
	}
}

function handleMissionInit(
	args: readonly string[],
	options: { json?: boolean },
): void {
	const missionId = args[0];
	if (!missionId) {
		throw new Error("mission init requires a mission id");
	}
	const title = args.slice(1).join(" ").trim() || missionId;
	const layout = getMissionArtifactLayout(missionId);
	const statePath = getMissionStatePath(missionId);
	if (
		!existsSync(statePath) &&
		existsSync(layout.missionDir) &&
		readdirSync(layout.missionDir).length > 0
	) {
		throw new Error(
			`mission state missing for existing mission: ${missionId}. Restore state.json instead of re-running init.`,
		);
	}
	const stateExists = existsSync(statePath);
	const snapshot = stateExists
		? MissionStore.load(missionId).getSnapshot()
		: MissionStore.create({ missionId, title }).save();
	if (
		snapshot.sourceMissionId &&
		snapshot.sourceMissionId !== missionId.trim() &&
		snapshot.missionId !== missionId.trim()
	) {
		throw new Error(
			`missionId "${missionId.trim()}" collides with existing mission "${snapshot.sourceMissionId}"`,
		);
	}
	const shouldSeedFeaturesArtifact =
		stateExists &&
		shouldSeedFeaturesArtifactFromState(layout.featuresJson, snapshot);
	const initializedLayout = initializeMissionArtifacts({ missionId, title });
	if (shouldSeedFeaturesArtifact) {
		writeJsonFile(initializedLayout.featuresJson, {
			version: MISSION_MANIFEST_VERSION,
			missionId: snapshot.missionId,
			milestones: [],
			features: snapshot.features,
			createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt,
		});
	}
	if (options.json) {
		console.log(
			JSON.stringify({ layout: initializedLayout, snapshot }, null, 2),
		);
		return;
	}
	console.log(chalk.bold("Mission initialized"));
	console.log(`id: ${snapshot.missionId}`);
	console.log(`dir: ${initializedLayout.missionDir}`);
}

function shouldSeedFeaturesArtifactFromState(
	featuresPath: string,
	snapshot: MissionStoreSnapshot,
): boolean {
	if (!existsSync(featuresPath)) return true;
	if (snapshot.features.length === 0) return false;
	const manifest = readJsonFile<MissionManifest | null>(featuresPath, {
		fallback: null,
		rotateOnParseFail: true,
	});
	return !manifest?.features?.length;
}

function handleMissionStatus(
	args: readonly string[],
	options: { json?: boolean },
): void {
	const missionId = args[0];
	if (missionId) {
		const snapshot = MissionStore.load(missionId).getSnapshot();
		if (options.json) {
			console.log(JSON.stringify(snapshot, null, 2));
			return;
		}
		console.log(summarizeMissionSnapshot(snapshot));
		return;
	}
	const snapshots = listMissionStoreSnapshots();
	if (options.json) {
		console.log(JSON.stringify(snapshots, null, 2));
		return;
	}
	if (snapshots.length === 0) {
		console.log(chalk.dim("No missions found."));
		return;
	}
	for (const snapshot of snapshots) {
		console.log(summarizeMissionSnapshot(snapshot));
		console.log("");
	}
}

function handleMissionRecord(
	args: readonly string[],
	options: { json?: boolean },
): void {
	const missionId = args[0];
	if (!missionId) {
		throw new Error("mission record requires a mission id");
	}
	const message = args.slice(1).join(" ").trim();
	if (!message) {
		throw new Error("mission record requires a message");
	}
	const snapshot = MissionStore.load(missionId).appendProgress({
		type: "note",
		message,
	});
	if (options.json) {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	console.log(`Recorded mission note for ${snapshot.missionId}.`);
}

function handleMissionSetState(
	args: readonly string[],
	options: { json?: boolean },
): void {
	const missionId = args[0];
	const state = args[1] as MissionState | undefined;
	if (!missionId || !state) {
		throw new Error("mission set-state requires <mission-id> <state>");
	}
	if (!isMissionState(state)) {
		throw new Error(`invalid mission state: ${state}`);
	}
	const message = args.slice(2).join(" ").trim() || undefined;
	const snapshot = MissionStore.load(missionId).setState(state, message);
	if (options.json) {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	console.log(`Mission ${snapshot.missionId} is now ${snapshot.state}.`);
}

function handleMissionValidate(
	args: readonly string[],
	options: { json?: boolean },
): void {
	const missionId = args[0];
	if (!missionId) {
		throw new Error("mission validate requires a mission id");
	}
	const layout = getMissionArtifactLayout(missionId);
	const requiredFiles = [
		layout.featuresJson,
		layout.validationStateJson,
		layout.servicesYaml,
		layout.stateJson,
	];
	const results = requiredFiles.map((path) => {
		try {
			return {
				path,
				...validateMissionArtifactContent(path, readTextFile(path)),
			};
		} catch {
			return {
				path,
				ok: false as const,
				message: "Missing required mission artifact",
			};
		}
	});
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
	if (options.json) {
		console.log(JSON.stringify(results, null, 2));
		return;
	}
	if (failed.length === 0) {
		console.log(`Mission ${missionId} artifacts are valid.`);
		return;
	}
	for (const result of failed) {
		console.log(
			chalk.red(
				`${result.path}: ${"message" in result ? result.message : "invalid"}`,
			),
		);
	}
}

function isMissionState(value: string): value is MissionState {
	return [
		"awaiting-input",
		"ready",
		"running",
		"blocked",
		"completed",
		"failed",
	].includes(value);
}
