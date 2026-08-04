#!/usr/bin/env node
/**
 * Standing guard against "registered but never fired" hooks.
 *
 * Scans production Rust sources under packages/tui-rs/src for call sites of
 * IntegratedHookSystem dispatch methods. Events listed as required must have
 * at least one non-test call site.
 *
 * Keep WIRED in sync with packages/tui-rs/src/agent/harness.rs WIRED_HOOK_EVENTS.
 *
 * Usage: node scripts/check-hook-dispatch-coverage.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages/tui-rs/src");

/** event label → dispatch method substrings that count as a production call */
const WIRED = {
  PreToolUse: ["execute_pre_tool_use", "run_pre_tool_use_hook"],
  PostToolUse: ["execute_post_tool_use"],
  // Same dispatch entry as PostToolUse; failure is selected by is_error=true
  // and asserted by harness `failed_tool_dispatches_post_tool_use_failure`.
  PostToolUseFailure: ["execute_post_tool_use"],
  SessionStart: ["on_session_start", "execute_session_start"],
  SessionEnd: ["on_session_end", "execute_session_end"],
  UserPromptSubmit: ["execute_user_prompt_submit"],
  Overflow: ["handle_overflow", "execute_overflow"],
  StopFailure: ["execute_stop_failure"],
  PreMessage: ["execute_pre_message"],
  PostMessage: ["execute_post_message"],
  EvalGate: ["execute_eval_gate"],
  SubagentStart: ["execute_subagent_start"],
  SubagentStop: ["execute_subagent_stop"],
  PermissionRequest: ["execute_permission_request"],
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === "tests" || name === "benches") continue;
      walk(path, out);
    } else if (name.endsWith(".rs") && !name.includes("test")) {
      out.push(path);
    }
  }
  return out;
}

function isTestPath(path) {
  const rel = relative(SRC, path).replaceAll("\\", "/");
  return rel.includes("/tests/") || rel.endsWith("/harness.rs") || rel.includes("/benches/");
}

/** Hook system implementation files — registry wiring is not a runtime call site. */
function isHookImplementation(path) {
  const rel = relative(SRC, path).replaceAll("\\", "/");
  return rel.startsWith("hooks/") || rel === "hooks.rs";
}

/**
 * Mask Rust comments and string/char literals so substring scans only see
 * executable code. Newlines are preserved so line indexes stay stable.
 *
 * Covers line comments, block comments, normal/byte strings, raw strings,
 * and char literals. Incomplete edge cases still mask more than they leave,
 * which is fail-closed for this guard (false negatives require a real call).
 */
function maskRustCommentsAndLiterals(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const spaceExceptNewline = (ch) => (ch === "\n" ? "\n" : " ");

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    // Line comment
    if (ch === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Block comment (Rust nests /* ... /* ... */ ... */)
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (text[i] === "/" && i + 1 < n && text[i + 1] === "*") {
          out += "  ";
          i += 2;
          depth += 1;
          continue;
        }
        if (text[i] === "*" && i + 1 < n && text[i + 1] === "/") {
          out += "  ";
          i += 2;
          depth -= 1;
          continue;
        }
        out += spaceExceptNewline(text[i]);
        i++;
      }
      continue;
    }

    // Raw string: r#"..."# / br#"..."# / cr#"..."# (any # count)
    if (
      (ch === "r" ||
        ((ch === "b" || ch === "c") && next === "r")) &&
      (() => {
        let j = ch === "r" ? i + 1 : i + 2;
        if (j >= n || text[j] !== "#") {
          // r"..." without hashes
          return j < n && text[j] === '"';
        }
        while (j < n && text[j] === "#") j++;
        return j < n && text[j] === '"';
      })()
    ) {
      // Prefix (r / br / cr)
      if (ch === "r") {
        out += " ";
        i += 1;
      } else {
        out += "  ";
        i += 2;
      }
      let hashes = 0;
      while (i < n && text[i] === "#") {
        out += " ";
        hashes++;
        i++;
      }
      // Opening quote
      if (i < n && text[i] === '"') {
        out += " ";
        i++;
      }
      const closer = '"' + "#".repeat(hashes);
      while (i < n) {
        if (text.startsWith(closer, i)) {
          out += " ".repeat(closer.length);
          i += closer.length;
          break;
        }
        out += spaceExceptNewline(text[i]);
        i++;
      }
      continue;
    }

    // Byte/normal string: "..." or b"..."
    if (ch === '"' || (ch === "b" && next === '"')) {
      if (ch === "b") {
        out += "  ";
        i += 2;
      } else {
        out += " ";
        i += 1;
      }
      while (i < n) {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          out += " ";
          i++;
          break;
        }
        out += spaceExceptNewline(text[i]);
        i++;
      }
      continue;
    }

    // Char literal: 'x' or '\n' (skip lifetimes like 'a by requiring close quote soon)
    if (ch === "'") {
      let j = i + 1;
      if (j < n && text[j] === "\\") j += 2;
      else j += 1;
      if (j < n && text[j] === "'") {
        out += " ".repeat(j - i + 1);
        i = j + 1;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Return line indexes that are production (non-test) code.
 *
 * Skips:
 * - entire `#[cfg(test)]` modules / items (balanced braces after the attr)
 * - individual `#[test]` / `#[tokio::test]` functions
 * - comments and string/char literals (masked before scan)
 */
function productionLineIndexes(text) {
  const masked = maskRustCommentsAndLiterals(text);
  const lines = masked.split("\n");
  const skip = new Array(lines.length).fill(false);

  function skipBalancedFrom(startLine) {
    // startLine is the attribute or the line after it; find first `{` from here
    let i = startLine;
    let foundBrace = false;
    let depth = 0;
    for (; i < lines.length; i++) {
      skip[i] = true;
      for (const ch of lines[i]) {
        if (ch === "{") {
          depth += 1;
          foundBrace = true;
        } else if (ch === "}") {
          depth -= 1;
          if (foundBrace && depth === 0) {
            return i;
          }
        }
      }
      // No brace yet and hit a blank-ended item with `;` (unlikely for modules)
      if (!foundBrace && lines[i].includes(";") && !lines[i].includes("{")) {
        return i;
      }
    }
    return lines.length - 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === "#[cfg(test)]" ||
      trimmed.startsWith("#[cfg(test),") ||
      trimmed.startsWith("#[cfg(all(test")
    ) {
      // Skip the attr and the following item (mod/fn/impl/...)
      skip[i] = true;
      i = skipBalancedFrom(i + 1);
      continue;
    }
    if (
      trimmed === "#[test]" ||
      trimmed === "#[tokio::test]" ||
      trimmed.startsWith("#[tokio::test(")
    ) {
      skip[i] = true;
      i = skipBalancedFrom(i + 1);
      continue;
    }
  }

  return lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ idx }) => !skip[idx]);
}

const files = walk(SRC);
const sources = files.map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

const missing = [];
for (const [event, needles] of Object.entries(WIRED)) {
  let found = false;
  for (const { path, text } of sources) {
    if (isHookImplementation(path) || isTestPath(path)) continue;
    for (const { line } of productionLineIndexes(text)) {
      if (!line.trim()) continue;
      // Skip pure definitions (fn execute_foo)
      if (/^\s*(pub\s+)?(async\s+)?fn\s+/.test(line) && needles.some((n) => line.includes(n))) {
        continue;
      }
      if (
        needles.some(
          (n) =>
            line.includes(`.${n}(`) ||
            line.includes(`hooks.${n}(`) ||
            line.includes(`self.hooks.${n}(`),
        )
      ) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) missing.push(event);
}

if (missing.length > 0) {
  console.error(
    "hook dispatch coverage failed: no production call site for:",
    missing.join(", "),
  );
  console.error(
    "Add a dispatch call or move the event to UNWIRED_HOOK_EVENTS / document why.",
  );
  process.exit(1);
}

console.log(
  `hook dispatch coverage ok (${Object.keys(WIRED).length} wired events have production call sites)`,
);
