import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HeadlessUtilityFileWatchChangeType } from "@evalops/contracts";
import {
	type FileChangeEvent,
	FileWatcher,
	type FileWatcherConfig,
} from "../tools/file-watcher.js";

export interface HeadlessUtilityFileWatchStartRequest {
	watch_id: string;
	root_dir?: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms?: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityFileWatchStartedEvent {
	type: "started";
	watch_id: string;
	root_dir: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityFileWatchEvent {
	type: "event";
	watch_id: string;
	change_type: HeadlessUtilityFileWatchChangeType;
	path: string;
	relative_path: string;
	timestamp: number;
	is_directory: boolean;
}

export interface HeadlessUtilityFileWatchStoppedEvent {
	type: "stopped";
	watch_id: string;
	reason?: string;
}

export type HeadlessUtilityFileWatchManagerEvent =
	| HeadlessUtilityFileWatchStartedEvent
	| HeadlessUtilityFileWatchEvent
	| HeadlessUtilityFileWatchStoppedEvent;

export interface HeadlessUtilityFileWatchSnapshot {
	watch_id: string;
	root_dir: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms: number;
	owner_connection_id?: string;
}

interface ActiveWatch {
	watcher: FileWatcher;
	root_dir: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms: number;
	owner_connection_id?: string;
	stopped: boolean;
	started: boolean;
}

const DEFAULT_DEBOUNCE_MS = 100;

function toHeadlessChangeType(
	eventType: FileChangeEvent["type"],
): HeadlessUtilityFileWatchChangeType {
	switch (eventType) {
		case "create":
		case "modify":
		case "delete":
		case "rename":
			return eventType;
	}
}

export class HeadlessUtilityFileWatchManager {
	private readonly watches = new Map<string, ActiveWatch>();

	constructor(
		private readonly emit: (
			event: HeadlessUtilityFileWatchManagerEvent,
		) => void,
	) {}

	snapshot(): HeadlessUtilityFileWatchSnapshot[] {
		return Array.from(this.watches.entries()).map(([watch_id, active]) => ({
			watch_id,
			root_dir: active.root_dir,
			include_patterns: active.include_patterns,
			exclude_patterns: active.exclude_patterns,
			debounce_ms: active.debounce_ms,
			owner_connection_id: active.owner_connection_id,
		}));
	}

	get(watchId: string): HeadlessUtilityFileWatchSnapshot | undefined {
		const active = this.watches.get(watchId);
		if (!active) {
			return undefined;
		}
		return {
			watch_id: watchId,
			root_dir: active.root_dir,
			include_patterns: active.include_patterns,
			exclude_patterns: active.exclude_patterns,
			debounce_ms: active.debounce_ms,
			owner_connection_id: active.owner_connection_id,
		};
	}

	async start(request: HeadlessUtilityFileWatchStartRequest): Promise<void> {
		if (this.watches.has(request.watch_id)) {
			throw new Error(`Utility file watch already exists: ${request.watch_id}`);
		}

		const rootDir = resolve(request.root_dir ?? process.cwd());
		const debounceMs = Math.max(0, request.debounce_ms ?? DEFAULT_DEBOUNCE_MS);
		if (!existsSync(rootDir)) {
			throw new Error(
				`Utility file watch root directory does not exist: ${rootDir}`,
			);
		}
		const watcherConfig: FileWatcherConfig = {
			rootDir,
			recursive: true,
			includePatterns: request.include_patterns ?? [],
			excludePatterns: request.exclude_patterns ?? [],
			debounceMs,
			watchGitState: false,
		};
		const watcher = new FileWatcher(watcherConfig);

		const active: ActiveWatch = {
			watcher,
			root_dir: rootDir,
			include_patterns: request.include_patterns,
			exclude_patterns: request.exclude_patterns,
			debounce_ms: debounceMs,
			owner_connection_id: request.owner_connection_id,
			stopped: false,
			started: false,
		};
		this.watches.set(request.watch_id, active);
		watcher.onFileChange((event) => {
			if (active.stopped) {
				return;
			}
			this.emit({
				type: "event",
				watch_id: request.watch_id,
				change_type: toHeadlessChangeType(event.type),
				path: event.path,
				relative_path: event.relativePath,
				timestamp: event.timestamp,
				is_directory: event.isDirectory,
			});
		});

		try {
			await watcher.start();
		} catch (error) {
			if (this.watches.get(request.watch_id) === active) {
				this.watches.delete(request.watch_id);
			}
			if (active.stopped) {
				return;
			}
			throw error;
		}
		if (this.watches.get(request.watch_id) !== active || active.stopped) {
			return;
		}
		active.started = true;
		this.emit({
			type: "started",
			watch_id: request.watch_id,
			root_dir: rootDir,
			include_patterns: request.include_patterns,
			exclude_patterns: request.exclude_patterns,
			debounce_ms: debounceMs,
			owner_connection_id: request.owner_connection_id,
		});
	}

	stop(watchId: string, reason?: string): void {
		const active = this.watches.get(watchId);
		if (!active) {
			return;
		}
		const shouldEmitStopped = active.started;
		active.stopped = true;
		this.watches.delete(watchId);
		active.watcher.stop();
		if (shouldEmitStopped) {
			this.emit({
				type: "stopped",
				watch_id: watchId,
				reason,
			});
		}
	}

	dispose(reason = "Headless runtime disposed"): void {
		const watchIds = Array.from(this.watches.keys());
		for (const watchId of watchIds) {
			this.stop(watchId, reason);
		}
	}

	disposeOwnedByConnection(connectionId: string, reason: string): void {
		const watchIds = Array.from(this.watches.entries())
			.filter(([, active]) => active.owner_connection_id === connectionId)
			.map(([watchId]) => watchId);
		for (const watchId of watchIds) {
			this.stop(watchId, reason);
		}
	}
}
