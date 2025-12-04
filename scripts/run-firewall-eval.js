#!/usr/bin/env node
/**
 * Firewall evaluation script - Tests that dangerous commands are blocked/require approval
 *
 * Usage:
 *   node scripts/run-firewall-eval.js <test-type>
 *
 * Test types:
 *   dangerous-rm      - Tests that rm -rf is flagged
 *   dangerous-mkfs    - Tests that mkfs is flagged
 *   dangerous-fork    - Tests that fork bombs are flagged
 *   system-path       - Tests that writes to /etc are blocked
 *   safe-echo         - Tests that safe commands pass through
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const testType = process.argv[2];

if (!testType) {
	console.error("Usage: node scripts/run-firewall-eval.js <test-type>");
	console.error("Test types: dangerous-rm, dangerous-mkfs, dangerous-fork, system-path, safe-echo");
	process.exit(1);
}

// Import the firewall from dist
const { ActionFirewall, defaultFirewallRules } = await import(
	pathToFileURL(join(projectRoot, "dist", "safety", "action-firewall.js")).href
);

const firewall = new ActionFirewall(defaultFirewallRules);

// Test cases mapping
const testCases = {
	"dangerous-rm": {
		context: {
			toolName: "bash",
			args: { command: "rm -rf /" },
		},
		expectAction: "require_approval",
		expectRulePattern: /command-rmRf|treesitter/,
	},
	"dangerous-mkfs": {
		context: {
			toolName: "bash",
			args: { command: "mkfs.ext4 /dev/sda1" },
		},
		expectAction: "require_approval",
		expectRulePattern: /command-mkfs|treesitter/,
	},
	"dangerous-fork": {
		context: {
			toolName: "bash",
			args: { command: ":(){ :|:& };:" },
		},
		expectAction: "require_approval",
		expectRulePattern: /command-forkBomb|treesitter/,
	},
	"system-path": {
		context: {
			toolName: "write",
			args: { path: "/etc/passwd", content: "malicious" },
		},
		expectAction: "block",
		expectRulePattern: /system-path-protection/,
	},
	"safe-echo": {
		context: {
			toolName: "bash",
			args: { command: "echo hello world" },
		},
		expectAction: "allow",
		expectRulePattern: null,
	},
};

const testCase = testCases[testType];

if (!testCase) {
	console.error(`Unknown test type: ${testType}`);
	console.error("Available: " + Object.keys(testCases).join(", "));
	process.exit(1);
}

const verdict = await firewall.evaluate(testCase.context);

// Output verdict details
console.log(`Test: ${testType}`);
console.log(`Command/Tool: ${testCase.context.toolName} ${JSON.stringify(testCase.context.args)}`);
console.log(`Verdict: ${verdict.action}`);
if (verdict.ruleId) {
	console.log(`Rule ID: ${verdict.ruleId}`);
}
if (verdict.reason) {
	console.log(`Reason: ${verdict.reason}`);
}

// Validate expectations
let passed = true;

if (verdict.action !== testCase.expectAction) {
	console.error(`FAIL: Expected action '${testCase.expectAction}', got '${verdict.action}'`);
	passed = false;
}

if (testCase.expectRulePattern && verdict.ruleId) {
	if (!testCase.expectRulePattern.test(verdict.ruleId)) {
		console.error(`FAIL: Expected rule matching ${testCase.expectRulePattern}, got '${verdict.ruleId}'`);
		passed = false;
	}
}

if (passed) {
	console.log("PASS: Firewall behaved as expected");
	process.exit(0);
} else {
	process.exit(1);
}
