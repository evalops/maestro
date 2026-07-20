import { type FSWatcher, existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import {
	type KeybindingConfigReport,
	inspectKeybindingConfig,
} from "./keybindings-config.js";
import {
	getTuiKeybindingsFilePath,
	resetTuiKeybindingConfigCache,
} from "./keybindings.js";

export interface TuiKeybindingWatcherOptions {
	env?: NodeJS.ProcessEnv;
	onReload?: (report: KeybindingConfigReport) => void;
}

let keybindingWatcher: FSWatcher | undefined;
let reloadTimeout: ReturnType<typeof setTimeout> | undefined;
let watcherGeneration = 0;

function clearWatcherTimer(): void {
	if (reloadTimeout) {
		clearTimeout(reloadTimeout);
		reloadTimeout = undefined;
	}
}

export function startTuiKeybindingWatcher(
	options: TuiKeybindingWatcherOptions = {},
): void {
	stopTuiKeybindingWatcher();
	const env = options.env ?? process.env;
	const filePath = getTuiKeybindingsFilePath(env);
	const configDir = dirname(filePath);
	if (!existsSync(configDir)) {
		return;
	}

	const expectedFilename = basename(filePath);
	const generation = watcherGeneration;

	try {
		keybindingWatcher = watch(configDir, (_eventType, filename) => {
			if (generation !== watcherGeneration) {
				return;
			}
			const changedFilename = filename?.toString();
			if (changedFilename && changedFilename !== expectedFilename) {
				return;
			}
			clearWatcherTimer();
			reloadTimeout = setTimeout(() => {
				if (generation !== watcherGeneration) {
					return;
				}
				resetTuiKeybindingConfigCache();
				options.onReload?.(inspectKeybindingConfig(env));
			}, 100);
		});
		keybindingWatcher.unref?.();
	} catch {
		// Ignore watcher setup failures; keybindings still reload on the next launch.
	}
}

export function stopTuiKeybindingWatcher(): void {
	watcherGeneration += 1;
	clearWatcherTimer();
	if (keybindingWatcher) {
		keybindingWatcher.close();
		keybindingWatcher = undefined;
	}
}
