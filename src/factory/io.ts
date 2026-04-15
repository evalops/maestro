import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FACTORY_SETTINGS_TEMPLATE = (
	defaultModel: string,
): string => `// Factory CLI Settings
// This file contains your Factory CLI configuration.
{
  "model": "${defaultModel}",
  "reasoningEffort": "medium",
  "cloudSessionSync": true,
  "diffMode": "github",
  "ideExtensionPromptedAt": {},
  "autonomyMode": "auto-high",
  "ideActivationNudgedForVersion": {},
  "enableCompletionBell": false,
  "completionSound": "fx-ack01",
  "completionSoundFocusMode": "always",
  "commandAllowlist": [
    "ls",
    "pwd",
    "dir"
  ],
  "commandDenylist": [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf .",
    "rm -rf ~",
    "rm -rf ~/*",
    "rm -rf $HOME",
    "rm -r /",
    "rm -r /*",
    "rm -r ~",
    "rm -r ~/*",
    "mkfs",
    "mkfs.ext4",
    "mkfs.ext3",
    "mkfs.vfat",
    "mkfs.ntfs",
    "dd if=/dev/zero of=/dev",
    "dd of=/dev",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "init 0",
    "init 6",
    ":(){ :|: & };:",
    ":() { :|:& };:",
    "chmod -R 777 /",
    "chmod -R 000 /",
    "chown -R",
    "format",
    "powershell Remove-Item -Recurse -Force"
  ],
  "enableCustomDroids": true,
  "enableHooks": false,
  "includeCoAuthoredByDroid": false,
  "enableDroidShield": false,
  "enableReadinessReport": false,
  "todoDisplayMode": "pinned",
  "autonomyLevel": "auto-high"
}
`;

export function ensureParentDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

export function writeJsonFile(path: string, value: unknown): void {
	ensureParentDir(path);
	writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

export function ensureFactorySettings(
	settingsPath: string,
	defaultModel: string,
): { created: boolean } {
	const existed = existsSync(settingsPath);
	if (!existed) {
		ensureParentDir(settingsPath);
		writeFileSync(
			settingsPath,
			FACTORY_SETTINGS_TEMPLATE(defaultModel),
			"utf-8",
		);
	}
	return { created: !existed };
}
