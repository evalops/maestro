import assert from "node:assert/strict";
import { test } from "node:test";

import { updatePullRequestBranches } from "./update-behind-auto-merge-prs.mjs";

const options = {
	dryRun: false,
	maxUpdates: 5,
	rebase: true,
	repo: "evalops/maestro-internal",
};

function pr(number) {
	return {
		headRefName: `feature-${number}`,
		number,
		title: `PR ${number}`,
	};
}

test("an isolated rebase conflict does not stop later PR updates", () => {
	const attempted = [];
	const warnings = [];
	const updates = [pr(3191), pr(3092), pr(3200)];

	const result = updatePullRequestBranches(updates, options, {
		log: () => {},
		warn: (message) => warnings.push(message),
		updateBranchImpl: (_repo, number) => {
			attempted.push(number);
			if (number === 3092) {
				const error = new Error(
					"Command failed: gh pr update-branch 3092 --rebase",
				);
				error.status = 1;
				error.stderr =
					"GraphQL: rebase conflict between base and head (updatePullRequestBranch)\r\n";
				throw error;
			}
			return "updated";
		},
	});

	assert.deepEqual(result, { attemptedUpdates: 3, successfulUpdates: 2 });
	assert.deepEqual(attempted, [3191, 3092, 3200]);
	assert.deepEqual(warnings, [
		"#3092 PR 3092: skipped because the branch has a rebase conflict.",
	]);
});

test("rebase conflicts refill the successful update batch from later PRs", () => {
	const attempted = [];
	const warnings = [];
	const updates = [pr(3092), pr(3093), pr(3200), pr(3201), pr(3202)];
	const result = updatePullRequestBranches(
		updates,
		{ ...options, maxUpdates: 2 },
		{
			log: () => {},
			warn: (message) => warnings.push(message),
			updateBranchImpl: (_repo, number) => {
				attempted.push(number);
				if (number === 3092 || number === 3093) {
					const error = new Error(
						`Command failed: gh pr update-branch ${number} --rebase`,
					);
					error.status = 1;
					error.stderr =
						"GraphQL: rebase conflict between base and head (updatePullRequestBranch)\n";
					throw error;
				}
				return "updated";
			},
		},
	);

	assert.deepEqual(result, { attemptedUpdates: 4, successfulUpdates: 2 });
	assert.deepEqual(attempted, [3092, 3093, 3200, 3201]);
	assert.equal(warnings.length, 2);
});

test("an all-conflict queue terminates after attempting each eligible PR", () => {
	const attempted = [];
	const updates = [pr(3092), pr(3093), pr(3094)];
	const result = updatePullRequestBranches(
		updates,
		{ ...options, maxUpdates: 2 },
		{
			log: () => {},
			warn: () => {},
			updateBranchImpl: (_repo, number) => {
				attempted.push(number);
				const error = new Error(
					`Command failed: gh pr update-branch ${number} --rebase`,
				);
				error.status = 1;
				error.stderr =
					"GraphQL: rebase conflict between base and head (updatePullRequestBranch)\n";
				throw error;
			},
		},
	);

	assert.deepEqual(result, { attemptedUpdates: 3, successfulUpdates: 0 });
	assert.deepEqual(attempted, [3092, 3093, 3094]);
});

test("a non-conflict update failure remains fatal", () => {
	const attempted = [];
	const failure = new Error("Command failed: gh pr update-branch 3191 --rebase");
	failure.status = 1;
	failure.stderr = "GraphQL: Resource not accessible by integration\n";

	assert.throws(
		() =>
			updatePullRequestBranches([pr(3191), pr(3200)], options, {
				log: () => {},
				warn: () => {},
				updateBranchImpl: (_repo, number) => {
					attempted.push(number);
					throw failure;
				},
			}),
		(error) => error === failure,
	);
	assert.deepEqual(attempted, [3191]);
});

test("rebase-conflict lookalikes remain fatal", () => {
	const conflict =
		"GraphQL: rebase conflict between base and head (updatePullRequestBranch)\n";
	const cases = [
		{
			error: Object.assign(new Error(conflict), { status: 1, stderr: "" }),
			options,
		},
		{
			error: Object.assign(new Error("update failed"), {
				status: 2,
				stderr: conflict,
			}),
			options,
		},
		{
			error: Object.assign(new Error("update failed"), {
				status: 1,
				stderr: conflict,
			}),
			options: { ...options, rebase: false },
		},
	];

	for (const scenario of cases) {
		const attempted = [];
		assert.throws(
			() =>
				updatePullRequestBranches([pr(3191), pr(3200)], scenario.options, {
					log: () => {},
					warn: () => {},
					updateBranchImpl: (_repo, number) => {
						attempted.push(number);
						throw scenario.error;
					},
				}),
			(error) => error === scenario.error,
		);
		assert.deepEqual(attempted, [3191]);
	}
});
