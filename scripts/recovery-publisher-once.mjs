#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NOT_FOUND_PATTERN = /(?:HTTP\s+404|404\s+Not Found|manifest unknown|name unknown|ghcr\.io\/\S+: not found)/iu;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export class CommandFailure extends Error {
	constructor(command, output) {
		super(`${command} failed: ${output.trim()}`);
		this.output = output;
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 120_000,
		...options,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) throw result.error;
	if (result.status !== 0) throw new CommandFailure(`${command} ${args.join(" ")}`, output);
	return output;
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requireMatch(name, value, pattern) {
	if (!pattern.test(value)) throw new Error(`${name} has an invalid value`);
}

export function isExplicitNotFound(error) {
	return error instanceof CommandFailure && NOT_FOUND_PATTERN.test(error.output);
}

export async function assertPublicationIsFresh({ lookupReservation, inspectImage }) {
	try {
		await lookupReservation();
		throw new Error("recovery publication is already reserved; refusing replay");
	} catch (error) {
		if (error.message === "recovery publication is already reserved; refusing replay") throw error;
		if (!isExplicitNotFound(error)) {
			throw new Error(`unable to prove reservation absence: ${error.message}`);
		}
	}

	try {
		const imageDigest = await inspectImage();
		requireMatch("recovery image digest", imageDigest, DIGEST_PATTERN);
		return { imageDigest };
	} catch (error) {
		if (!isExplicitNotFound(error)) {
			throw new Error(`unable to prove recovery image absence: ${error.message}`);
		}
		return { imageDigest: null };
	}
}

export async function reserveAndDispatch({ reserve, dispatch, afterDispatch = async () => {} }) {
	await reserve();
	await dispatch();
	await afterDispatch();
}

async function preflight() {
	const repository = requireEnv("GITHUB_REPOSITORY");
	const reservationTag = requireEnv("RECOVERY_RESERVATION_TAG");
	const image = requireEnv("IMAGE_NAME");
	const sourceSha = requireEnv("RECOVERY_SOURCE_SHA");
	const state = await assertPublicationIsFresh({
		lookupReservation: async () => run("gh", ["api", `repos/${repository}/git/ref/tags/${reservationTag}`]),
		inspectImage: async () => {
			const manifest = JSON.parse(run("docker", [
				"buildx", "imagetools", "inspect", `${image}:sha-${sourceSha}`,
				"--format", "{{json .Manifest}}",
			]));
			requireMatch("recovery image digest", manifest.digest, DIGEST_PATTERN);
			return manifest.digest;
		},
	});
	const output = requireEnv("GITHUB_OUTPUT");
	appendFileSync(output, `image_exists=${state.imageDigest ? "true" : "false"}\n`);
	appendFileSync(output, `image_digest=${state.imageDigest ?? ""}\n`);
}

async function reserveAndDispatchCli() {
	const repository = requireEnv("GITHUB_REPOSITORY");
	const reservationTag = requireEnv("RECOVERY_RESERVATION_TAG");
	const publisherSha = requireEnv("GITHUB_SHA");
	const deployToken = requireEnv("RUNTIME_IMAGE_SYNC_TOKEN");
	const sourceSha = requireEnv("SOURCE_SHA");
	const imageDigest = requireEnv("IMAGE_DIGEST");
	const compatibilityDigest = requireEnv("PROTOCOL_COMPATIBILITY_DIGEST");
	const receiptDigest = requireEnv("PROTOCOL_RECEIPT_DIGEST");
	requireMatch("GITHUB_SHA", publisherSha, SHA_PATTERN);
	requireMatch("SOURCE_SHA", sourceSha, SHA_PATTERN);
	requireMatch("IMAGE_DIGEST", imageDigest, DIGEST_PATTERN);
	requireMatch("PROTOCOL_COMPATIBILITY_DIGEST", compatibilityDigest, DIGEST_PATTERN);
	requireMatch("PROTOCOL_RECEIPT_DIGEST", receiptDigest, DIGEST_PATTERN);

	await reserveAndDispatch({
		reserve: async () => run("gh", [
			"api", "--method", "POST", `repos/${repository}/git/refs`,
			"-f", `ref=refs/tags/${reservationTag}`, "-f", `sha=${publisherSha}`,
		]),
		dispatch: async () => run("gh", [
			"api", "--method", "POST", "repos/evalops/k8s/dispatches",
			"-f", "event_type=maestro_runtime_image_published",
			"-f", `client_payload[source_sha]=${sourceSha}`,
			"-f", `client_payload[image_tag]=sha-${sourceSha}`,
			"-f", `client_payload[image_digest]=${imageDigest}`,
			"-f", "client_payload[protocol_manifest_schema_version]=evalops.maestro.protocol-compatibility-manifest.v1",
			"-f", `client_payload[protocol_compatibility_digest]=${compatibilityDigest}`,
			"-f", `client_payload[protocol_receipt_digest]=${receiptDigest}`,
		], { env: { ...process.env, GH_TOKEN: deployToken } }),
	});
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	const command = process.argv[2];
	const action = command === "preflight" ? preflight : command === "reserve-and-dispatch" ? reserveAndDispatchCli : null;
	if (!action) {
		console.error("usage: recovery-publisher-once.mjs <preflight|reserve-and-dispatch>");
		process.exitCode = 2;
	} else {
		await action().catch((error) => {
			console.error(`error: ${error.message}`);
			process.exitCode = 1;
		});
	}
}
