import { css } from "lit";

export const composerSettingsStyles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--bg-primary);
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.settings-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.25rem 1.5rem;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-primary);
		}

		.settings-header h2 {
			font-size: 0.9rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary);
			letter-spacing: -0.01em;
		}

		.close-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: none;
			border-radius: var(--radius-sm, 6px);
			color: var(--text-tertiary);
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease;
			font-size: 0.95rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.close-btn:hover {
			background: var(--bg-panel);
			color: var(--text-primary);
		}

		.settings-content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}

		.section {
			margin-bottom: 2rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-subtle);
			border-radius: 8px;
			overflow: hidden;
		}

		.section-header {
			padding: 0.75rem 1rem;
			background: var(--bg-panel);
			border-bottom: 1px solid var(--border-primary);
		}

		.section-header h3 {
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-secondary);
			text-transform: none;
			letter-spacing: 0;
		}

		.section-content {
			padding: 1rem;
		}

		.info-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.75rem 1.5rem;
			font-size: 0.8rem;
			line-height: 1.6;
		}

		.info-label {
			font-family: var(--font-sans, "Inter", sans-serif);
			color: var(--text-tertiary);
			font-size: 0.7rem;
			text-transform: none;
			letter-spacing: 0;
			padding-top: 0.15em;
		}

		.info-value {
			color: var(--text-primary);
			word-break: break-all;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.info-value.highlight {
			color: var(--accent-blue);
		}

		.info-value.success {
			color: var(--accent-green);
		}

		.info-value.warning {
			color: var(--accent-yellow);
		}

		.info-value.error {
			color: var(--accent-red);
		}

		.badge {
			display: inline-block;
			padding: 0.15rem 0.4rem;
			background: var(--bg-panel);
			border: 1px solid var(--border-subtle);
			border-radius: 4px;
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: none;
			margin-right: 0.35rem;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.badge.active {
			background: var(--accent-blue-dim);
			color: var(--accent-blue);
			border-color: transparent;
		}

		.badge.success {
			background: rgba(16, 185, 129, 0.1);
			color: var(--accent-green);
			border-color: transparent;
		}

		.badge.error {
			background: rgba(239, 68, 68, 0.1);
			color: var(--accent-red);
			border-color: transparent;
		}

		.model-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 1rem;
		}

		.model-card {
			background: var(--bg-primary);
			border: 1px solid var(--border-subtle);
			border-radius: 6px;
			padding: 1rem;
			transition: all 0.2s;
			cursor: pointer;
		}

		.model-card:hover {
			border-color: var(--accent-blue);
			transform: translateY(-1px);
			box-shadow: var(--shadow-sm);
		}

		.model-card.selected {
			border-color: var(--accent-blue);
			background: var(--accent-blue-dim);
		}

		.model-name {
			font-size: 0.9rem;
			font-weight: 600;
			color: var(--text-primary);
			margin-bottom: 0.25rem;
			font-family: var(--font-sans);
		}

		.model-provider {
			font-size: 0.7rem;
			color: var(--text-tertiary);
			text-transform: none;
			letter-spacing: 0;
			margin-bottom: 0.75rem;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.model-stats {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
			margin-top: 0.75rem;
		}

		.usage-stats {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 1rem;
			margin-bottom: 1.5rem;
		}

		.stat-card {
			background: var(--bg-secondary);
			border: 1px solid var(--border-subtle);
			border-radius: 8px;
			padding: 1rem;
			text-align: center;
		}

		.stat-value {
			font-size: 1.5rem;
			font-weight: 700;
			color: var(--text-primary);
			margin-bottom: 0.35rem;
			font-family: var(--font-sans, "Inter", sans-serif);
			letter-spacing: -0.03em;
		}

		.stat-label {
			font-size: 0.7rem;
			color: var(--text-secondary);
			text-transform: none;
			letter-spacing: 0;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.empty-state {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.loading {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			text-transform: none;
			letter-spacing: 0;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.error-message {
			background: rgba(239, 68, 68, 0.1);
			border-left: 3px solid var(--accent-red);
			padding: 0.75rem 1rem;
			margin-bottom: 1rem;
			font-size: 0.8rem;
			color: var(--accent-red);
			line-height: 1.5;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.control-row {
			display: flex;
			flex-wrap: wrap;
			gap: 0.75rem;
			align-items: center;
			margin-bottom: 0.75rem;
		}

		.field-input,
		.field-select {
			background: var(--bg-primary);
			border: 1px solid var(--border-subtle);
			border-radius: 6px;
			padding: 0.65rem 0.75rem;
			color: var(--text-primary);
			font-size: 0.78rem;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.field-input {
			flex: 1 1 240px;
		}

		.field-select {
			min-width: 140px;
		}

		.action-btn {
			background: var(--bg-panel);
			border: 1px solid var(--border-subtle);
			border-radius: 6px;
			padding: 0.65rem 0.85rem;
			color: var(--text-secondary);
			font-size: 0.72rem;
			font-family: var(--font-sans, "Inter", sans-serif);
			text-transform: none;
			letter-spacing: 0;
			cursor: pointer;
			transition: all 0.2s;
		}

		.action-btn:hover {
			color: var(--text-primary);
			border-color: var(--border-secondary);
			transform: translateY(-1px);
		}

		.action-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
			transform: none;
		}

		.panel-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
			gap: 0.75rem;
		}

		.panel-card {
			background: var(--bg-primary);
			border: 1px solid var(--border-subtle);
			border-radius: 8px;
			padding: 0.9rem;
			display: flex;
			flex-direction: column;
			gap: 0.6rem;
		}

		.panel-card-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.panel-card-title {
			font-size: 0.84rem;
			font-weight: 600;
			color: var(--text-primary);
		}

		.panel-card-copy {
			font-size: 0.75rem;
			color: var(--text-secondary);
			line-height: 1.55;
		}

		.panel-badges {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
		}

		.panel-link-row {
			display: flex;
			flex-wrap: wrap;
			gap: 0.85rem;
			font-size: 0.72rem;
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.panel-link-row a {
			color: var(--accent-blue);
			text-decoration: none;
		}

		.panel-link-row a:hover {
			text-decoration: underline;
		}

		.panel-feedback {
			border-radius: 8px;
			padding: 0.75rem 0.9rem;
			font-size: 0.75rem;
			font-family: var(--font-sans, "Inter", sans-serif);
			line-height: 1.5;
		}

		.panel-feedback.error {
			background: rgba(239, 68, 68, 0.1);
			border: 1px solid rgba(239, 68, 68, 0.3);
			color: var(--accent-red);
		}

		.panel-feedback.success {
			background: rgba(16, 185, 129, 0.1);
			border: 1px solid rgba(16, 185, 129, 0.3);
			color: var(--accent-green);
		}

		.panel-code-block {
			margin: 0;
			padding: 0.75rem 0.9rem;
			border-radius: 8px;
			border: 1px solid var(--border-subtle);
			background: var(--bg-panel);
			font-size: 0.72rem;
			font-family: var(--font-mono, monospace);
			line-height: 1.55;
			color: var(--text-secondary);
			white-space: pre-wrap;
			word-break: break-word;
		}

		@media (max-width: 768px) {
			.model-grid {
				grid-template-columns: 1fr;
			}

			.usage-stats {
				grid-template-columns: 1fr;
			}

			.control-row {
				flex-direction: column;
				align-items: stretch;
			}
		}
`;
