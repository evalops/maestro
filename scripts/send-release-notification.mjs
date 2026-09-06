#!/usr/bin/env node

const webhookUrl =
	process.env.SLACK_RELEASE_WEBHOOK_URL ?? process.env.RELEASE_WEBHOOK_URL ?? "";

if (!webhookUrl) {
	console.log("Release webhook not configured; skipping notification.");
	process.exit(0);
}

const status = process.env.RELEASE_STATUS ?? "unknown";
const repository = process.env.GITHUB_REPOSITORY ?? "unknown";
const version = process.env.RELEASE_VERSION ?? "unknown";
const packageName = process.env.RELEASE_PACKAGE_NAME ?? "";
const packageVersion = process.env.RELEASE_PACKAGE_VERSION ?? version;
const runUrl =
	process.env.GITHUB_SERVER_URL &&
	process.env.GITHUB_REPOSITORY &&
	process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
		: "";

const statusConfig = {
	success: { emoji: ":white_check_mark:", label: "succeeded" },
	failure: { emoji: ":x:", label: "failed" },
	cancelled: { emoji: ":warning:", label: "was cancelled" },
	skipped: { emoji: ":pause_button:", label: "was skipped" },
};

const { emoji, label } =
	statusConfig[status] ?? { emoji: ":grey_question:", label: status };
const lines = [`${emoji} ${repository} release ${version} ${label}.`];

if (packageName) {
	lines.push(`Package: \`${packageName}@${packageVersion}\``);
}
if (runUrl) {
	lines.push(`<${runUrl}|View workflow run>`);
}

const response = await fetch(webhookUrl, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		text: lines.join("\n"),
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: lines.join("\n"),
				},
			},
		],
	}),
});

if (!response.ok) {
	const body = await response.text();
	throw new Error(
		`Release notification failed: ${response.status} ${response.statusText} ${body}`,
	);
}

console.log("Release notification sent.");
