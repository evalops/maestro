#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// App Attest requires a registered app ID and an authorized distribution
// profile. Never produce a development/ad-hoc substitute for enrollment.
const [platform, output] = process.argv.slice(2);
if (process.platform !== "darwin" || !/^darwin-(arm64|x64)$/.test(platform ?? "") || !output) {
  throw new Error("Usage on macOS: build-code-device.mjs darwin-<arm64|x64> <output.app>");
}
const signing = process.env.MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY;
const team = process.env.MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER;
const profile = process.env.MAESTRO_CODE_DEVICE_PROVISIONING_PROFILE;
if (!signing || !/^[A-Z0-9]{10}$/.test(team ?? "") || !profile) {
  throw new Error("Code device release requires Developer ID signing, team ID, and an App Attest provisioning profile");
}
const identifier = "com.evalops.deixic-code-device";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("App Attest requires a stable numeric release version");
const bundle = resolve(output);
const contents = resolve(bundle, "Contents");
const executable = resolve(contents, "MacOS", "deixic-code-device");
mkdirSync(resolve(contents, "MacOS"), { recursive: true });
writeFileSync(resolve(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>deixic-code-device</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
copyFileSync(profile, resolve(contents, "embedded.provisionprofile"));
const arch = platform === "darwin-arm64" ? "arm64" : "x86_64";
execFileSync("xcrun", ["swiftc", "-parse-as-library", "-O", "-target", `${arch}-apple-macos14.0`,
  new URL("../native/code-device/main.swift", import.meta.url).pathname, "-o", executable], { stdio: "inherit" });
chmodSync(executable, 0o755);
const entitlements = resolve(contents, "code-device-entitlements.plist");
writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${team}.${identifier}</string>
<key>com.apple.developer.team-identifier</key><string>${team}</string>
<key>com.apple.developer.devicecheck.appattest-environment</key><string>production</string>
</dict></plist>`);
execFileSync("codesign", ["--sign", signing, "--options", "runtime", "--timestamp", "--entitlements", entitlements, bundle], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
console.log(`Built Code device helper ${bundle}; Identity app ID ${team}.${identifier}, admitted version ${version}`);
