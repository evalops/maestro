#!/usr/bin/env node
/**
 * Fail if the removed TypeScript TUI reappears in live code paths or nx graph.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const bannedExact = ["@evalops/tui", "packages/tui/", "src/cli-tui/", "../tui/"];
const bannedProjectNames = new Set(["tui"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const roots = ["packages", "src", "scripts", ".github", "project.json", "package.json", "nx.json"].map((r) => join(root, r));
const files = [];
for (const r of roots) {
  try {
    const st = statSync(r);
    if (st.isDirectory()) walk(r, files);
    else files.push(r);
  } catch {
    // missing ok
  }
}

const offenders = [];
for (const file of files) {
  if (!/\.(json|yml|yaml|ts|tsx|js|mjs|cjs|toml|rs|Dockerfile|dockerfile)$/i.test(file) && !file.endsWith("Dockerfile")) continue;
  if (file.includes("/test/scripts/install-smoke") || file.includes("/test/scripts/smoke-published") || file.includes("/test/scripts/verify-published")) continue;
  if (file.includes("/test/testing/auto-verify")) continue;
  if (file.endsWith("check-removed-ts-tui-refs.mjs")) continue;
  if (file.includes("prepare-public-release-mirror.mjs")) continue;
  if (file.includes("check-public-mirror")) continue;
  if (file.includes("sync-public-companion")) continue;
  if (file.includes("sync-release-mirror")) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const b of bannedExact) {
    if (!text.includes(b)) continue;
    if (b === "packages/tui/") {
      const re = /packages\/tui(?!-rs)/g;
      if (!re.test(text)) continue;
    }
    offenders.push(`${file}: contains ${b}`);
  }
  if (file.endsWith("project.json")) {
    try {
      const j = JSON.parse(text);
      for (const d of j.implicitDependencies || []) {
        if (bannedProjectNames.has(d)) offenders.push(`${file}: implicitDependencies includes removed project '${d}'`);
      }
    } catch {
      // ignore
    }
  }
}

if (offenders.length) {
  console.error("Removed TypeScript TUI references found:");
  for (const o of offenders) console.error(" -", o);
  process.exit(1);
}
console.log("check-removed-ts-tui-refs: ok");
