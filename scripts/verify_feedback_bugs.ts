
import { checkPolicy, EnterprisePolicy } from "../src/safety/policy.js";
import { defaultActionFirewall } from "../src/safety/action-firewall.js";
import type { ActionApprovalContext } from "../src/agent/action-approval.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const POLICY_PATH = join(homedir(), ".maestro", "policy.json");

function cleanup() {
    if (existsSync(POLICY_PATH)) unlinkSync(POLICY_PATH);
}

function createCtx(toolName: string, command?: string): ActionApprovalContext {
    return {
        toolName,
        args: command ? { command } : {},
        metadata: {},
    };
}

async function testAllowListLogic() {
    console.log("--- Testing Allow List Logic ---");
    cleanup();

    // Scenario: Admin wants to allow NOTHING by setting allowed: []
    const policy: EnterprisePolicy = {
        dependencies: {
            allowed: [], // Should block everything
            blocked: []
        }
    };

    writeFileSync(POLICY_PATH, JSON.stringify(policy));

    // Try to install 'react'
    const res = await checkPolicy(createCtx("bash", "npm install react"));

    if (res.allowed) {
        console.log("[FAIL] Allow list logic error: 'allowed: []' permitted a dependency.");
    } else {
        console.log("[PASS] Allow list logic correct: 'allowed: []' blocked dependency.");
    }
}

async function testDoubleExecution() {
    console.log("\n--- Testing Double Execution ---");
    // We can't easily spy on checkPolicy without mocking, but we can verify the fix structure later.
    // For now, this script focuses on the logic bug.
    console.log("(Skipping runtime verification of double-exec, will verify by code inspection)");
}

async function main() {
    try {
        await testAllowListLogic();
    } catch (error) {
        console.error(error);
    } finally {
        cleanup();
    }
}

main();
