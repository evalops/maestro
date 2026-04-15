/**
 * Security Status Component - Real-time security alerts in the TUI
 *
 * Subscribes to security events and displays warnings via the footer toast system.
 * Shows banners for high-severity events like blocked tools, detected threats,
 * and loop detection.
 *
 * @module cli-tui/security-status
 */

import {
	type AdvisoryLevel,
	SecurityAdvisor,
	type SecurityAdvisory,
} from "../safety/security-advisor.js";
import {
	type SecurityEvent,
	onSecurityEvent,
} from "../telemetry/security-events.js";
import { createLogger } from "../utils/logger.js";
import type { FooterComponent } from "./footer.js";

const logger = createLogger("cli-tui:security-status");

/**
 * Configuration for security status display
 */
export interface SecurityStatusConfig {
	/** Show toasts for low severity events. Default: false */
	showLowSeverity: boolean;
	/** Show toasts for medium severity events. Default: true */
	showMediumSeverity: boolean;
	/** Enable advisory notifications. Default: true */
	enableAdvisories: boolean;
	/** Minimum advisory level to display. Default: "warning" */
	minAdvisoryLevel: AdvisoryLevel;
}

/**
 * Default configuration
 */
export const DEFAULT_SECURITY_STATUS_CONFIG: SecurityStatusConfig = {
	showLowSeverity: false,
	showMediumSeverity: true,
	enableAdvisories: true,
	minAdvisoryLevel: "warning",
};

/**
 * Map security severity to footer toast tone
 */
function severityToTone(
	severity: string,
): "info" | "warn" | "success" | "danger" {
	switch (severity) {
		case "critical":
			return "danger";
		case "high":
			return "danger";
		case "medium":
			return "warn";
		default:
			return "info";
	}
}

/**
 * Map advisory level to footer toast tone
 */
function advisoryLevelToTone(
	level: AdvisoryLevel,
): "info" | "warn" | "success" | "danger" {
	switch (level) {
		case "critical":
			return "danger";
		case "alert":
			return "danger";
		case "warning":
			return "warn";
		default:
			return "info";
	}
}

/**
 * Format a security event for display as a toast
 */
function formatEventMessage(event: SecurityEvent): string {
	const toolPart = event.toolName ? ` [${event.toolName}]` : "";
	return `${event.description}${toolPart}`;
}

/**
 * Format an advisory for display as a toast
 */
function formatAdvisoryMessage(advisory: SecurityAdvisory): string {
	return `${advisory.title}: ${advisory.description.slice(0, 100)}${advisory.description.length > 100 ? "..." : ""}`;
}

/**
 * Security Status Component
 *
 * Provides real-time security feedback in the TUI through the footer toast system.
 */
export class SecurityStatus {
	private readonly config: SecurityStatusConfig;
	private readonly footer: FooterComponent;
	private readonly advisor: SecurityAdvisor;
	private unsubscribeEvent: (() => void) | null = null;
	private unsubscribeAdvisory: (() => void) | null = null;
	private onRender: (() => void) | null = null;

	constructor(
		footer: FooterComponent,
		config: Partial<SecurityStatusConfig> = {},
		onRender?: () => void,
	) {
		this.config = { ...DEFAULT_SECURITY_STATUS_CONFIG, ...config };
		this.footer = footer;
		this.onRender = onRender ?? null;

		// Create advisor for aggregated threat analysis
		this.advisor = new SecurityAdvisor({
			enableRealtime: false, // We'll manually subscribe
		});

		this.start();
	}

	/**
	 * Start listening for security events
	 */
	start(): void {
		if (this.unsubscribeEvent) return;

		// Subscribe to raw security events
		this.unsubscribeEvent = onSecurityEvent((event) => {
			this.handleSecurityEvent(event);
		});

		// Subscribe to aggregated advisories if enabled
		if (this.config.enableAdvisories) {
			this.advisor.startRealtime();
			this.unsubscribeAdvisory = this.advisor.onAdvisory((advisory) => {
				this.handleAdvisory(advisory);
			});
		}

		logger.debug("Security status monitoring started");
	}

	/**
	 * Stop listening for security events
	 */
	stop(): void {
		if (this.unsubscribeEvent) {
			this.unsubscribeEvent();
			this.unsubscribeEvent = null;
		}

		if (this.unsubscribeAdvisory) {
			this.unsubscribeAdvisory();
			this.unsubscribeAdvisory = null;
		}

		this.advisor.stopRealtime();
		logger.debug("Security status monitoring stopped");
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		this.stop();
		this.advisor.dispose();
	}

	/**
	 * Handle incoming security event
	 */
	private handleSecurityEvent(event: SecurityEvent): void {
		// Filter based on severity configuration
		if (event.severity === "low" && !this.config.showLowSeverity) {
			return;
		}
		if (event.severity === "medium" && !this.config.showMediumSeverity) {
			return;
		}

		// Always show high/critical events
		if (event.severity === "high" || event.severity === "critical") {
			const message = formatEventMessage(event);
			const tone = severityToTone(event.severity);
			this.footer.setToast(message, tone);
			this.onRender?.();
			logger.info("Security event displayed", {
				type: event.type,
				severity: event.severity,
			});
		}
	}

	/**
	 * Handle aggregated security advisory
	 */
	private handleAdvisory(advisory: SecurityAdvisory): void {
		// Filter based on minimum advisory level
		const levelOrder: AdvisoryLevel[] = [
			"info",
			"warning",
			"alert",
			"critical",
		];
		const minIndex = levelOrder.indexOf(this.config.minAdvisoryLevel);
		const advIndex = levelOrder.indexOf(advisory.level);

		if (advIndex < minIndex) {
			return;
		}

		const message = formatAdvisoryMessage(advisory);
		const tone = advisoryLevelToTone(advisory.level);
		this.footer.setToast(message, tone);
		this.onRender?.();
		logger.info("Security advisory displayed", {
			title: advisory.title,
			level: advisory.level,
		});
	}

	/**
	 * Get current threat level summary
	 */
	getThreatLevel(): { level: AdvisoryLevel; score: number; summary: string } {
		return this.advisor.getThreatLevel();
	}

	/**
	 * Get recent advisories
	 */
	getRecentAdvisories(limit = 5): SecurityAdvisory[] {
		return this.advisor.getRecentAdvisories(limit);
	}

	/**
	 * Trigger an immediate threat assessment and show results
	 */
	showThreatAssessment(): void {
		const threat = this.advisor.getThreatLevel();
		const advisories = this.advisor.analyze();

		if (advisories.length > 0) {
			// Show most critical advisory
			const mostCritical = advisories.reduce((a, b) =>
				["critical", "alert", "warning", "info"].indexOf(a.level) <
				["critical", "alert", "warning", "info"].indexOf(b.level)
					? a
					: b,
			);
			const message = `Threat ${threat.level.toUpperCase()}: ${mostCritical.title}`;
			const tone = advisoryLevelToTone(mostCritical.level);
			this.footer.setToast(message, tone);
		} else {
			this.footer.setToast(
				`Threat Level: ${threat.level.toUpperCase()} - ${threat.summary}`,
				"info",
			);
		}
		this.onRender?.();
	}
}

/**
 * Create a security status component
 */
export function createSecurityStatus(
	footer: FooterComponent,
	config?: Partial<SecurityStatusConfig>,
	onRender?: () => void,
): SecurityStatus {
	return new SecurityStatus(footer, config, onRender);
}
