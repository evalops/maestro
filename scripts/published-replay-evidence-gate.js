#!/usr/bin/env node
// @ts-check

export function assertPublishedReplayReleaseGate(evidence) {
	if (evidence?.releaseGate?.satisfied === true) {
		return;
	}
	const failedChecks = Array.isArray(evidence?.releaseGate?.failedChecks)
		? evidence.releaseGate.failedChecks.join(", ")
		: "unknown";
	throw new Error(`Published replay release gate failed: ${failedChecks}`);
}
