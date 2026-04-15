#!/usr/bin/env node
/**
 * Install the Composer native messaging host manifest.
 *
 * Resolution order for extension ID:
 * 1) --extension-id / CONDUCTOR_EXTENSION_ID
 * 2) CONDUCTOR_PEM_PATH / ../conductor/conductor.pem
 * 3) Scan Chrome profiles for an installed Conductor extension
 */

import { readFile, writeFile, mkdir, readdir, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const HOST_PATH = path.resolve(ROOT, "scripts", "bridge", "native-host.js");
const HOST_NAME = "com.evalops.composer_bridge";

const args = process.argv.slice(2);
const argIndex = args.findIndex((value) => value === "--extension-id");
const argExtensionId = argIndex >= 0 ? args[argIndex + 1] : null;

const envExtensionId = process.env.CONDUCTOR_EXTENSION_ID || null;
const envPemPath = process.env.CONDUCTOR_PEM_PATH || null;

async function deriveExtensionIdFromPem(pemContent) {
  try {
    const crypto = await import("node:crypto");
    const key = crypto.createPrivateKey(pemContent);
    const publicKey = crypto.createPublicKey(key);
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    const hash = createHash("sha256").update(publicKeyDer).digest();
    // Chrome extension IDs are 32 characters: each byte produces 2 hex chars mapped to 'a'-'p'
    return Array.from(hash.slice(0, 16))
      .flatMap((byte) => [
        String.fromCharCode(97 + ((byte >> 4) & 0x0f)), // high nibble
        String.fromCharCode(97 + (byte & 0x0f)),        // low nibble
      ])
      .join("");
  } catch {
    return null;
  }
}

async function findPemExtensionId() {
  const candidates = [];
  if (envPemPath) candidates.push(envPemPath);
  candidates.push(path.resolve(ROOT, "..", "conductor", "conductor.pem"));

  for (const candidate of candidates) {
    try {
      const pem = await readFile(candidate, "utf8");
      const id = await deriveExtensionIdFromPem(pem);
      if (id) return id;
    } catch {
      // ignore missing/invalid PEM
    }
  }
  return null;
}

async function listProfileDirs(baseDir) {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findInstalledExtensionId() {
  if (process.platform !== "darwin") return null;
  const chromeBase = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome"
  );
  const profiles = await listProfileDirs(chromeBase);
  for (const profile of profiles) {
    const extensionsRoot = path.join(chromeBase, profile, "Extensions");
    let extensionDirs = [];
    try {
      extensionDirs = await readdir(extensionsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const extensionDir of extensionDirs) {
      if (!extensionDir.isDirectory()) continue;
      const extensionId = extensionDir.name;
      const versionRoot = path.join(extensionsRoot, extensionId);
      let versionDirs = [];
      try {
        versionDirs = await readdir(versionRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const versionDir of versionDirs) {
        if (!versionDir.isDirectory()) continue;
        const manifestPath = path.join(versionRoot, versionDir.name, "manifest.json");
        try {
          const raw = await readFile(manifestPath, "utf8");
          const manifest = JSON.parse(raw);
          const updateUrl = manifest.update_url || "";
          const name = manifest.name || "";
          if (updateUrl.includes("evalops.dev") || name === "Conductor") {
            return extensionId;
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  }
  return null;
}

function resolveManifestPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      `${HOST_NAME}.json`
    );
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA;
    if (!base) return null;
    return path.join(
      base,
      "Google",
      "Chrome",
      "User Data",
      "NativeMessagingHosts",
      `${HOST_NAME}.json`
    );
  }
  return path.join(
    os.homedir(),
    ".config",
    "google-chrome",
    "NativeMessagingHosts",
    `${HOST_NAME}.json`
  );
}

async function main() {
  let extensionId = argExtensionId || envExtensionId;

  if (!extensionId) {
    extensionId = await findPemExtensionId();
  }
  if (!extensionId) {
    extensionId = await findInstalledExtensionId();
  }

  if (!extensionId) {
    console.error(
      [
        "Unable to determine Conductor extension ID.",
        "Provide it via --extension-id or CONDUCTOR_EXTENSION_ID,",
        "or set CONDUCTOR_PEM_PATH to a conductor.pem file,",
        "or install the extension so it can be discovered in Chrome profiles.",
      ].join(" ")
    );
    process.exit(1);
  }

  const manifestPath = resolveManifestPath();
  if (!manifestPath) {
    console.error("Unable to resolve native host manifest path for this OS.");
    process.exit(1);
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });

  const payload = {
    name: HOST_NAME,
    description: "Composer native host for the Conductor bridge",
    path: HOST_PATH,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  // Chrome requires the native host script to be executable on Unix-like systems
  if (process.platform !== "win32") {
    await chmod(HOST_PATH, 0o755);
  }

  console.log(`Installed native host manifest at ${manifestPath}`);
  console.log(`Allowed extension: ${extensionId}`);
}

await main();
