/**
 * Dashboard Registry - Tracks deployed dashboards for the gallery UI.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardSpec } from "../dashboard/types.js";

export type DashboardVisibility = "private" | "shared";

export interface LiveDashboardDefinition {
	/** Natural language instructions for how to build/refresh this dashboard. */
	prompt: string;
	title?: string;
	subtitle?: string;
	theme?: "dark" | "light";
	/** Refresh interval in ms (default: 5 minutes). */
	refreshIntervalMs?: number;
	createdBy?: string;
}

export interface CreateLiveDashboardInput extends LiveDashboardDefinition {
	label: string;
	/** Defaults to private. */
	visibility?: DashboardVisibility;
}

export interface DashboardEntry {
	id: string;
	label: string;
	/** Creator (Slack user ID) when available. */
	createdBy?: string;
	/** Controls whether other workspace users can discover/view this dashboard. */
	visibility?: DashboardVisibility;
	sharedAt?: string;
	sharedBy?: string;
	/** Legacy: deployed URL (non-live dashboards). */
	url?: string;
	/** Legacy: deployed directory (non-live dashboards). */
	directory?: string;
	/** Legacy: deployed port (non-live dashboards). */
	port?: number;
	createdAt: string;
	updatedAt?: string;
	expiresAt?: string;
	/** Last render timestamp for live dashboards. */
	lastRenderedAt?: string;
	/** Last render error message for live dashboards. */
	lastError?: string;
	spec?: DashboardSpec;
	/** Live (BI) dashboard definition. If present, /render should refresh spec from live data. */
	definition?: LiveDashboardDefinition;
}

export class DashboardRegistry {
	private entries: DashboardEntry[] = [];
	private readonly filePath: string;

	constructor(workingDir: string) {
		this.filePath = join(workingDir, "dashboards.json");
		this.load();
	}

	register(entry: Omit<DashboardEntry, "id" | "createdAt">): DashboardEntry {
		const dashboard: DashboardEntry = {
			...entry,
			id: `dash-${randomUUID()}`,
			createdAt: new Date().toISOString(),
		};
		this.entries.push(dashboard);
		this.save();
		return dashboard;
	}

	createDefinition(input: CreateLiveDashboardInput): DashboardEntry {
		const dashboard: DashboardEntry = {
			id: `dash-${randomUUID()}`,
			label: input.label,
			createdBy: input.createdBy,
			visibility: input.visibility ?? "private",
			createdAt: new Date().toISOString(),
			definition: {
				prompt: input.prompt,
				title: input.title,
				subtitle: input.subtitle,
				theme: input.theme,
				refreshIntervalMs: input.refreshIntervalMs,
				createdBy: input.createdBy,
			},
		};
		this.entries.push(dashboard);
		this.save();
		return dashboard;
	}

	list(): DashboardEntry[] {
		return [...this.entries].sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	}

	get(id: string): DashboardEntry | undefined {
		return this.entries.find((e) => e.id === id);
	}

	update(
		id: string,
		patch: Partial<Omit<DashboardEntry, "id" | "createdAt">>,
	): DashboardEntry | undefined {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return undefined;
		Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
		this.save();
		return entry;
	}

	remove(id: string): boolean {
		const len = this.entries.length;
		this.entries = this.entries.filter((e) => e.id !== id);
		if (this.entries.length !== len) {
			this.save();
			return true;
		}
		return false;
	}

	private load(): void {
		if (existsSync(this.filePath)) {
			try {
				const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
				this.entries = Array.isArray(raw.dashboards) ? raw.dashboards : [];
			} catch {
				this.entries = [];
			}
		}
	}

	private save(): void {
		writeFileSync(
			this.filePath,
			JSON.stringify({ dashboards: this.entries }, null, "\t"),
		);
	}
}
