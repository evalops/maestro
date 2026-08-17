import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function channelRelease({ stableVersion, channel, ordinal }) {
	const match = SEMVER.exec(stableVersion);
	if (!match) throw new Error(`Stable version must be plain semver: ${stableVersion}`);
	if (channel !== "alpha" && channel !== "beta") {
		throw new Error(`Channel must be alpha or beta: ${channel}`);
	}
	if (!/^[1-9]\d*$/.test(String(ordinal))) {
		throw new Error(`Ordinal must be a positive integer: ${ordinal}`);
	}

	const [, major, minor, patch] = match;
	const patchOffset = channel === "alpha" ? 2 : 1;
	return {
		channel,
		sourceOffset: channel === "alpha" ? 0 : 1,
		version: `${major}.${minor}.${Number(patch) + patchOffset}-${channel}.${ordinal}`,
	};
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [stableVersion, channel, ordinal] = process.argv.slice(2);
	try {
		process.stdout.write(`${JSON.stringify(channelRelease({ stableVersion, channel, ordinal }))}\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
