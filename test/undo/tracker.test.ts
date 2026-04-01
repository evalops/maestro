import { describe, expect, it } from "vitest";
import { ChangeTracker } from "../../src/undo/tracker.js";
import type { ChangeTrackerState } from "../../src/undo/types.js";

function createState(): ChangeTrackerState {
	return {
		changes: [
			{
				id: "chg_1",
				type: "modify",
				path: "/tmp/original.txt",
				before: "before",
				after: "after",
				toolName: "write",
				toolCallId: "call_1",
				timestamp: 1,
				isGitTracked: false,
				messageId: "msg_1",
			},
		],
		checkpoints: [
			{
				name: "initial",
				description: "initial checkpoint",
				timestamp: 2,
				changeId: "chg_1",
				changeCount: 1,
			},
		],
		maxChanges: 10,
	};
}

describe("ChangeTracker", () => {
	it("returns isolated snapshots from getters and export", () => {
		const tracker = new ChangeTracker();
		tracker.import(createState());

		const changes = tracker.getChanges();
		const lastChanges = tracker.getLastChanges(1);
		const checkpoints = tracker.getCheckpoints();
		const exported = tracker.export();

		changes[0]!.path = "/tmp/mutated-change.txt";
		lastChanges[0]!.toolName = "bash";
		checkpoints[0]!.name = "mutated-checkpoint";
		exported.changes.push({
			id: "chg_2",
			type: "create",
			path: "/tmp/extra.txt",
			before: null,
			after: "new",
			toolName: "write",
			toolCallId: "call_2",
			timestamp: 3,
			isGitTracked: false,
		});
		exported.checkpoints.push({
			name: "extra",
			timestamp: 4,
			changeId: "chg_2",
			changeCount: 2,
		});
		exported.maxChanges = 99;

		expect(tracker.getChanges()).toEqual(createState().changes);
		expect(tracker.getCheckpoints()).toEqual(createState().checkpoints);
		expect(tracker.export()).toEqual(createState());
	});

	it("clones imported state instead of retaining caller-owned references", () => {
		const tracker = new ChangeTracker();
		const sourceState = createState();

		tracker.import(sourceState);

		sourceState.changes[0]!.path = "/tmp/mutated-source.txt";
		sourceState.checkpoints[0]!.name = "mutated-source";
		sourceState.changes.push({
			id: "chg_2",
			type: "delete",
			path: "/tmp/deleted.txt",
			before: "gone",
			after: null,
			toolName: "edit",
			toolCallId: "call_2",
			timestamp: 5,
			isGitTracked: false,
		});
		sourceState.checkpoints.push({
			name: "later",
			timestamp: 6,
			changeId: "chg_2",
			changeCount: 2,
		});
		sourceState.maxChanges = 99;

		expect(tracker.getChanges()).toEqual(createState().changes);
		expect(tracker.getCheckpoints()).toEqual(createState().checkpoints);
		expect(tracker.export()).toEqual(createState());
	});
});
