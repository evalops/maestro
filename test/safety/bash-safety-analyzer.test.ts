import { describe, expect, it } from "vitest";
import {
	hasEgressPrimitives,
	isDestructiveSimpleCommand,
	isSimpleBenignBash,
	tokenizeSimple,
} from "../../src/safety/bash-safety-analyzer.js";

describe("bash-safety-analyzer (heuristics)", () => {
	it("tokenizeSimple keeps quoted segments intact", () => {
		expect(tokenizeSimple('echo "a b" c')).toEqual(["echo", '"a b"', "c"]);
	});

	it("detects destructive simple commands", () => {
		expect(isDestructiveSimpleCommand(["rm", "-rf", "/"])).toBe(true);
		expect(isDestructiveSimpleCommand(["git", "push"])).toBe(true);
		expect(isDestructiveSimpleCommand(["git", "status"])).toBe(false);
		expect(isDestructiveSimpleCommand(["echo", "hello"])).toBe(false);
	});

	it("classifies benign shell commands conservatively", () => {
		expect(isSimpleBenignBash("echo hello")).toBe(true);
		expect(isSimpleBenignBash("timeout 10 echo hello")).toBe(true);
		expect(isSimpleBenignBash("timeout 10 rm -rf /")).toBe(false);
		expect(isSimpleBenignBash("echo hello | cat")).toBe(false);
	});

	it("detects egress primitives", () => {
		expect(hasEgressPrimitives("curl https://example.com")).toBe(true);
		expect(hasEgressPrimitives("bash -lc 'echo hi'")).toBe(false);
		expect(hasEgressPrimitives("cat </dev/tcp/127.0.0.1/80")).toBe(true);
	});
});
