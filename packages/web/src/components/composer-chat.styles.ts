import { css } from "lit";

export const composerChatStyles = css`
		:host {
			display: flex !important;
			height: 100% !important;
			width: 100% !important;
			background: var(--bg-primary, #0c0d0f);
			color: var(--text-primary, #e8e9eb);
			overflow: hidden;
			font-family: var(--font-sans, 'Inter', sans-serif);
		}

		/* Main Content */
		.main-content {
			flex: 1;
			display: flex;
			flex-direction: column;
			position: relative;
			min-width: 0;
			background: var(--bg-primary, #0c0d0f);
		}

		:host([zen]) composer-session-sidebar {
			display: none;
		}

		:host([zen]) .header {
			display: none;
		}

		:host([zen]) .messages {
			padding-top: 2.5rem;
		}

		.header {
			display: grid;
			grid-template-columns: auto 1fr auto;
			align-items: center;
			gap: 1rem;
			padding: 0.5rem 1rem;
			background: var(--bg-primary, #1a1b1d);
			border-bottom: 1px solid var(--border-subtle, #1f2022);
			min-height: 44px;
			z-index: 10;
		}

		.header-left {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.toggle-sidebar-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: none;
			border-radius: var(--radius-sm, 6px);
			color: var(--text-tertiary, #8e8e8e);
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.toggle-sidebar-btn:hover {
			background: var(--bg-elevated, #232427);
			color: var(--text-primary, #ececec);
		}

		.header h1 {
			font-family: var(--font-display, "Inter", sans-serif);
			font-size: 0.9rem;
			font-weight: 500;
			margin: 0;
			color: var(--text-primary, #ececec);
			letter-spacing: -0.005em;
		}

		.status-bar {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			flex-wrap: nowrap;
			white-space: nowrap;
			overflow-x: auto;
			min-width: 0;
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			color: var(--text-tertiary, #8e8e8e);
			justify-content: center;
		}

		.status-item {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.2rem 0.55rem;
			background: transparent;
			border: 1px solid transparent;
			border-radius: var(--radius-sm, 6px);
			font-size: 0.7rem;
			font-weight: 500;
			transition: background 0.12s ease, color 0.12s ease;
			color: var(--text-tertiary, #8e8e8e);
		}

		.status-item:hover {
			background: var(--bg-elevated, #232427);
			color: var(--text-secondary, #b4b4b4);
		}

		.status-item.active {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.16));
			color: var(--accent-amber, #d4a012);
			border-color: transparent;
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: nowrap;
			white-space: nowrap;
		}

		.pill {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.15rem 0.5rem;
			background: var(--bg-elevated, #232427);
			color: var(--text-secondary, #b4b4b4);
			font-weight: 500;
			font-size: 0.65rem;
			text-transform: none;
			letter-spacing: 0;
			border-radius: 999px;
		}

		.pill.warning {
			background: var(--accent-yellow-dim, rgba(234, 179, 8, 0.12));
			color: var(--accent-yellow, #eab308);
		}

		.pill.success {
			background: var(--accent-green-dim, rgba(34, 197, 94, 0.12));
			color: var(--accent-green, #22c55e);
		}

		.pill.error {
			background: var(--accent-red-dim, rgba(239, 68, 68, 0.12));
			color: var(--accent-red, #ef4444);
		}

		.pill.info {
			background: rgba(20, 184, 166, 0.12);
			color: var(--accent, #14b8a6);
		}

		.status-note {
			color: var(--accent-yellow, #eab308);
			text-transform: none;
			letter-spacing: 0;
		}

		.status-item.runtime-status {
			border-color: rgba(20, 184, 166, 0.18);
			background: rgba(20, 184, 166, 0.04);
		}

		.status-dot {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-green, #22c55e);
			box-shadow: 0 0 6px var(--accent-green, #22c55e);
		}

		.status-dot.offline {
			background: var(--accent-red, #ef4444);
			box-shadow: none;
		}

		.status-dot.warning {
			background: var(--accent-yellow, #eab308);
			box-shadow: 0 0 6px var(--accent-yellow, #eab308);
		}

		.status-dot.error {
			background: var(--accent-red, #ef4444);
			box-shadow: 0 0 6px var(--accent-red, #ef4444);
		}

		/* Messages Area */
		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 2rem clamp(1rem, 8vw, 8rem) 1.5rem;
			display: flex;
			flex-direction: column;
			background: var(--bg-primary, #1a1b1d);
			scroll-behavior: smooth;
		}

		.messages.compact {
			padding: 1.25rem clamp(0.75rem, 4vw, 3rem);
		}

		.virtual-spacer {
			width: 100%;
			display: block;
		}

		.history-truncation {
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			border: 1px solid var(--border-subtle, #1e2023);
			background: var(--bg-elevated, #161719);
			padding: 0.5rem 0.75rem;
			margin-bottom: 0.75rem;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.history-btn {
			border: 1px solid var(--border-subtle, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 26px;
			padding: 0 0.6rem;
			cursor: pointer;
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.65rem;
			letter-spacing: 0;
			text-transform: none;
		}

		.history-btn:hover {
			background: var(--bg-surface, #1a1b1e);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--accent-amber, #d4a012);
		}

		.history-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}

		.jump-latest {
			position: sticky;
			bottom: 0.75rem;
			align-self: center;
			border: 1px solid var(--border-subtle, #1e2023);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.12));
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.7rem;
			padding: 0.5rem 0.8rem;
			cursor: pointer;
			letter-spacing: 0.02em;
			backdrop-filter: blur(8px);
			z-index: 5;
		}

		.jump-latest:hover {
			border-color: var(--accent-blue, #3b82f6);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.18));
		}

		.input-container {
			padding: 0.75rem clamp(1rem, 8vw, 8rem) 1.25rem;
			background: var(--bg-primary, #1a1b1d);
			border-top: none;
			position: sticky;
			bottom: 0;
			z-index: 15;
		}

		/* Model Selector */
		.model-selector {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.25rem 0.65rem;
			background: var(--bg-elevated, #232427);
			border: 1px solid transparent;
			border-radius: 999px;
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.72rem;
			color: var(--text-secondary, #b4b4b4);
			font-weight: 500;
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
		}

		.model-selector:hover {
			background: var(--bg-surface, #26282b);
			border-color: var(--border-secondary, #3a3d42);
			color: var(--text-primary, #ececec);
		}

		.model-badge {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-amber, #d4a012);
		}

		/* Icon Buttons */
		.icon-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: none;
			border-radius: var(--radius-sm, 6px);
			color: var(--text-tertiary, #8e8e8e);
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.icon-btn:hover {
			background: var(--bg-elevated, #232427);
			color: var(--text-primary, #ececec);
		}

		.icon-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.icon-btn:disabled:hover {
			background: transparent;
			border-color: var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
		}

		.icon-btn.active {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			border: 1px solid var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
		}

		.icon {
			width: 14px;
			height: 14px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.5;
			stroke-linecap: round;
			stroke-linejoin: round;
			pointer-events: none;
		}

		/* Toast */
		.toast {
			position: fixed;
			bottom: 20px;
			right: 20px;
			padding: 0.6rem 1rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-subtle, #1e2023);
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.75rem;
			box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
			z-index: 300;
			display: flex;
			align-items: center;
			gap: 0.75rem;
			animation: slideIn 0.2s ease;
		}

		@keyframes slideIn {
			from { opacity: 0; transform: translateX(10px); }
			to { opacity: 1; transform: translateX(0); }
		}

		.toast.success { border-left: 2px solid var(--accent-green, #22c55e); }
		.toast.error { border-left: 2px solid var(--accent-red, #ef4444); }
		.toast.info { border-left: 2px solid var(--accent-amber, #d4a012); }

		.side-panel {
			position: absolute;
			top: 0;
			right: 0;
			height: 100%;
			background: var(--bg-primary, #0a0e14);
			border-left: 2px solid var(--border-primary, #21262d);
			z-index: 100;
		}

		.side-panel.settings {
			width: min(500px, 92vw);
		}

		.side-panel.admin {
			width: min(800px, 95vw);
			z-index: 110;
		}

		.health-popover {
			position: fixed;
			top: 64px;
			right: 12px;
			width: min(360px, calc(100vw - 24px));
			background: var(--bg-secondary, #0d1117);
			border: 1px solid var(--border-secondary, #30363d);
			padding: 0.75rem;
			z-index: 120;
			box-shadow: var(--shadow-md, 0 10px 24px rgba(0, 0, 0, 0.4));
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.75rem;
			color: var(--text-primary, #e6edf3);
		}

		.health-popover-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 0.5rem;
		}

		.health-popover-label {
			color: var(--text-tertiary, #6e7681);
			letter-spacing: 0;
		}

		.health-popover-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			margin: 0.35rem 0;
			color: var(--text-secondary, #b4b4b4);
		}

		.health-popover-row strong {
			color: var(--text-primary, #e6edf3);
			font-weight: 600;
		}

		.health-popover-row span {
			color: var(--text-tertiary, #6e7681);
			flex: 0 0 auto;
		}

		.health-popover-row .health-row-value {
			min-width: 0;
			text-align: right;
			overflow-wrap: anywhere;
		}

		.health-slo-list {
			display: flex;
			flex-direction: column;
			gap: 0.45rem;
			margin-top: 0.65rem;
			padding-top: 0.65rem;
			border-top: 1px solid var(--border-subtle, #1e2023);
		}

		.health-slo {
			border: 1px solid var(--border-subtle, #1e2023);
			background: var(--bg-primary, #0a0e14);
			padding: 0.55rem;
		}

		.health-slo.unhealthy {
			border-color: rgba(239, 68, 68, 0.45);
		}

		.health-slo.degraded {
			border-color: rgba(234, 179, 8, 0.45);
		}

		.health-slo-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
			margin-bottom: 0.3rem;
		}

		.health-slo-label {
			color: var(--text-primary, #e6edf3);
			font-weight: 600;
		}

		.health-slo-observed {
			color: var(--text-secondary, #b4b4b4);
			overflow-wrap: anywhere;
		}

		.health-slo-target,
		.health-slo-detail {
			margin-top: 0.2rem;
			color: var(--text-tertiary, #6e7681);
			overflow-wrap: anywhere;
		}

		.shortcuts-modal {
			position: fixed;
			top: 30%;
			left: 50%;
			transform: translateX(-50%);
			width: min(420px, 90vw);
			background: var(--bg-secondary, #0d1117);
			border: 1px solid var(--border-secondary, #30363d);
			padding: 1rem;
			z-index: 140;
			box-shadow: var(--shadow-lg, 0 18px 40px rgba(0, 0, 0, 0.5));
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.78rem;
			color: var(--text-primary, #e6edf3);
		}

		.shortcuts-modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 0.75rem;
		}

		.shortcuts-modal-title {
			letter-spacing: 0;
			color: var(--text-tertiary, #8b949e);
		}

		.shortcuts-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.35rem 0.75rem;
		}

		/* Empty State */
		.empty-state {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			padding: 2rem;
			background: var(--bg-primary, #0c0d0f);
		}

		.workspace-panel {
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 1rem;
			background: transparent;
			border: none;
			margin: 2rem 0;
			width: 100%;
			max-width: 800px;
		}

		.panel-section {
			background: var(--bg-elevated, #161719);
			padding: 1rem;
			border: 1px solid var(--border-subtle, #1e2023);
		}

		.panel-section h3 {
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--text-tertiary, #5c5e62);
			text-transform: none;
			letter-spacing: 0;
			margin: 0 0 0.75rem 0;
		}

		.panel-item {
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.75rem;
			color: var(--text-primary, #e8e9eb);
			margin: 0.4rem 0;
			display: flex;
			align-items: center;
		}

		.panel-item span {
			color: var(--text-tertiary, #5c5e62);
			margin-right: 0.5rem;
			min-width: 2.5rem;
		}

		.session-gallery {
			margin-top: 1.5rem;
			width: 100%;
			max-width: 800px;
			background: transparent;
			border: none;
			box-shadow: none;
			padding: 0;
		}

		.session-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
			gap: 0.75rem;
		}

		.session-card {
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-subtle, #1e2023);
			padding: 1rem;
			text-align: left;
			cursor: pointer;
			transition: all 0.15s ease;
			color: var(--text-primary, #e8e9eb);
		}

		.session-card:hover {
			border-color: var(--accent-amber, #d4a012);
			background: var(--bg-surface, #1a1b1e);
		}

		.session-card-title {
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.8rem;
			font-weight: 500;
			margin-bottom: 0.35rem;
		}

		.session-card-meta {
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.62rem;
			color: var(--text-tertiary, #5c5e62);
			display: flex;
			gap: 0.35rem;
			flex-wrap: wrap;
		}

		.session-card-summary {
			margin-top: 0.55rem;
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.68rem;
			line-height: 1.45;
			color: var(--text-secondary, #a4a8ae);
		}

		.onboarding-callout {
			width: 100%;
			max-width: 800px;
			margin-top: 0.5rem;
			padding: 1rem 1.1rem;
			background: linear-gradient(
				135deg,
				rgba(20, 184, 166, 0.08),
				rgba(245, 158, 11, 0.05)
			);
			border: 1px solid rgba(20, 184, 166, 0.16);
		}

		.onboarding-callout h3 {
			margin: 0 0 0.35rem 0;
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.7rem;
			letter-spacing: 0;
			text-transform: none;
			color: var(--text-secondary, #a4a8ae);
		}

		.onboarding-callout p {
			margin: 0 0 0.75rem 0;
			font-size: 0.88rem;
			color: var(--text-secondary, #a4a8ae);
		}

		.onboarding-list {
			margin: 0;
			padding-left: 1.1rem;
			display: grid;
			gap: 0.45rem;
			color: var(--text-primary, #e8e9eb);
		}

		.onboarding-list code {
			font-size: 0.85em;
		}

		.onboarding-actions {
			margin-top: 0.9rem;
			display: flex;
			flex-wrap: wrap;
			gap: 0.65rem;
		}

		.onboarding-action {
			background: var(--bg-elevated, #161719);
			border: 1px solid rgba(20, 184, 166, 0.2);
			color: var(--text-primary, #e8e9eb);
			padding: 0.55rem 0.8rem;
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.72rem;
			cursor: pointer;
			transition: border-color 0.15s ease, background 0.15s ease;
		}

		.onboarding-action:hover {
			border-color: rgba(20, 184, 166, 0.36);
			background: var(--bg-surface, #1a1b1e);
		}

		.onboarding-action.command {
			border-color: rgba(245, 158, 11, 0.22);
		}

		.onboarding-action.command:hover {
			border-color: rgba(245, 158, 11, 0.38);
		}

		/* Responsive */
		@media (max-width: 768px) {
			.workspace-panel {
				grid-template-columns: 1fr;
			}
		}

		.sidebar-overlay {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.4);
			z-index: 15;
			display: none;
		}

		@media (max-width: 960px) {
			.header {
				grid-template-columns: 1fr;
				gap: 0.5rem;
				padding: 0.6rem 0.85rem;
			}
			.status-bar {
				flex-wrap: wrap;
				row-gap: 0.4rem;
				justify-content: flex-start;
			}
			.header-right {
				flex-wrap: wrap;
				justify-content: flex-start;
				gap: 0.35rem;
			}
			.messages {
				padding: 1.1rem 1.25rem;
			}
		}

		@media (max-width: 640px) {
			.header {
				padding: 0.55rem 0.75rem;
			}
			.header h1 {
				font-size: 0.9rem;
			}
			.status-bar {
				display: none;
			}
			.messages {
				padding: 0.9rem 0.9rem;
			}
		}

		@media (max-width: 768px) {
			.sidebar-overlay.active {
				display: block;
			}
		}
`;
