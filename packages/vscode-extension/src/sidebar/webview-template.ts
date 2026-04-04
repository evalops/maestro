import type * as vscode from "vscode";

export interface WebviewTemplateOptions {
	nonce: string;
	vendorUri: vscode.Uri;
	styleUri: vscode.Uri;
	cspSource: string;
	cspConnect: string;
}

export function getWebviewStyles(): string {
	return /* css */ `
		:root {
			--bg-primary: var(--vscode-editor-background);
			--bg-secondary: var(--vscode-sideBar-background);
			--text-primary: var(--vscode-editor-foreground);
			--text-secondary: var(--vscode-descriptionForeground);
			--border-color: var(--vscode-panel-border);
			--accent-color: var(--vscode-button-background);
			--accent-hover: var(--vscode-button-hoverBackground);
		}

		body {
			padding: 0;
			margin: 0;
			font-family: var(--vscode-font-family);
			color: var(--text-primary);
			background-color: var(--bg-secondary);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}

		.container {
			display: flex;
			flex-direction: column;
			height: 100%;
			position: relative;
		}

		.header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--border-color);
			display: flex;
			align-items: center;
			justify-content: space-between;
			background: var(--bg-secondary);
		}

		h2 {
			margin: 0;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--text-secondary);
		}

		.status-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: #6b7280;
			transition: all 0.3s ease;
		}

		.status-dot.active {
			background: #10b981;
			box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
		}

		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 16px;
			display: flex;
			flex-direction: column;
			gap: 16px;
		}

		.message {
			display: flex;
			gap: 12px;
			font-size: 13px;
			line-height: 1.5;
		}

		.message.assistant {
			background: rgba(255, 255, 255, 0.03);
			border-radius: 8px;
			padding: 12px;
			border: 1px solid var(--border-color);
		}

		.message .avatar {
			width: 24px;
			height: 24px;
			border-radius: 4px;
			background: var(--accent-color);
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: bold;
			font-size: 12px;
			flex-shrink: 0;
		}

		.message.user .avatar {
			background: #6b7280;
		}

		.message-content {
			flex: 1;
			min-width: 0;
			word-wrap: break-word;
		}

		/* Markdown Content Styles */
		.message-content p { margin: 0.5em 0; }
		.message-content p:first-child { margin-top: 0; }
		.message-content p:last-child { margin-bottom: 0; }
		.message-content pre {
			background: var(--vscode-editor-background);
			padding: 8px;
			border-radius: 4px;
			overflow-x: auto;
			border: 1px solid var(--border-color);
		}
		.message-content code {
			font-family: var(--vscode-editor-font-family);
			font-size: 0.9em;
			background: rgba(127, 127, 127, 0.1);
			padding: 0.2em 0.4em;
			border-radius: 3px;
		}
		.message-content pre code {
			background: transparent;
			padding: 0;
		}

		.context-bar {
			font-size: 11px;
			padding: 6px 12px;
			background: var(--vscode-editor-lineHighlightBackground);
			border-bottom: 1px solid var(--border-color);
			display: flex;
			flex-direction: column;
			gap: 4px;
			color: var(--text-secondary);
		}

		.runtime-status {
			display: none;
			font-size: 11px;
			padding: 6px 12px;
			background: rgba(255, 255, 255, 0.04);
			border-bottom: 1px solid var(--border-color);
			color: var(--text-secondary);
		}

		.runtime-status.visible {
			display: block;
		}

		.context-row {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.input-area {
			padding: 16px;
			background: var(--bg-secondary);
			border-top: 1px solid var(--border-color);
		}

		.input-container {
			position: relative;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
		}

		textarea {
			width: 100%;
			background: transparent;
			border: none;
			color: var(--text-primary);
			font-family: inherit;
			padding: 10px;
			resize: none;
			min-height: 40px;
			box-sizing: border-box;
			outline: none;
		}

		.input-actions {
			display: flex;
			justify-content: space-between;
			padding: 4px 8px 8px;
		}

		button {
			background: var(--accent-color);
			color: white;
			border: none;
			padding: 6px 12px;
			border-radius: 4px;
			cursor: pointer;
			font-family: inherit;
			font-weight: 500;
			font-size: 12px;
			transition: opacity 0.2s;
		}
		button:hover {
			opacity: 0.9;
		}

		.context-pill {
			font-size: 10px;
			padding: 2px 6px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			border-radius: 10px;
			display: inline-flex;
			align-items: center;
			gap: 4px;
		}

		.context-pill .remove-btn {
			cursor: pointer;
			font-weight: bold;
			margin-left: 2px;
		}

		.thinking {
			font-style: italic;
			color: var(--text-secondary);
			margin-bottom: 8px;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.thinking-dots::after {
			content: '';
			animation: dots 1.5s infinite;
		}
		@keyframes dots {
			0% { content: ''; }
			33% { content: '.'; }
			66% { content: '..'; }
			100% { content: '...'; }
		}

		.tool-call {
			margin: 8px 0;
			border: 1px solid var(--border-color);
			border-radius: 6px;
			overflow: hidden;
			background: rgba(255, 255, 255, 0.02);
		}

		.tool-header {
			padding: 8px 12px;
			background: rgba(255, 255, 255, 0.05);
			display: flex;
			justify-content: space-between;
			align-items: center;
			font-size: 11px;
			cursor: pointer;
			user-select: none;
		}

		.tool-header:hover {
			background: rgba(255, 255, 255, 0.08);
		}

		.tool-name {
			font-family: var(--vscode-editor-font-family);
			font-weight: 600;
			color: var(--accent-color);
		}

		.tool-status {
			display: flex;
			align-items: center;
			gap: 6px;
			color: var(--text-secondary);
		}

		.tool-body {
			display: none;
			padding: 12px;
			font-family: var(--vscode-editor-font-family);
			font-size: 11px;
			border-top: 1px solid var(--border-color);
		}

		.tool-call.expanded .tool-body {
			display: block;
		}

		.tool-section {
			margin-bottom: 8px;
		}
		.tool-section:last-child { margin-bottom: 0; }
		.tool-section-title {
			font-weight: 600;
			margin-bottom: 4px;
			color: var(--text-secondary);
			text-transform: uppercase;
			font-size: 10px;
		}
		.tool-code {
			white-space: pre-wrap;
			word-break: break-all;
			color: var(--text-primary);
		}

		.approval-request {
			border: 1px solid var(--accent-color);
			border-radius: 6px;
			background: rgba(255, 255, 255, 0.05);
			margin: 8px 0;
			padding: 12px;
		}

		.approval-header {
			font-weight: 600;
			margin-bottom: 8px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			color: var(--accent-color);
		}

		.approval-reason {
			font-size: 11px;
			margin-bottom: 12px;
			color: var(--text-secondary);
		}

		.approval-actions {
			display: flex;
			gap: 8px;
		}

		.approval-actions button {
			flex: 1;
		}

		.btn-approve {
			background: #10b981;
		}
		.btn-deny {
			background: #ef4444;
		}

		.suggestions {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			background: var(--bg-secondary);
			border: 1px solid var(--border-color);
			border-bottom: none;
			max-height: 200px;
			overflow-y: auto;
			z-index: 100;
			border-radius: 6px 6px 0 0;
			display: none;
			box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
		}
		.suggestions.visible {
			display: block;
		}
		.suggestion-item {
			padding: 8px 12px;
			cursor: pointer;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			border-bottom: 1px solid var(--border-color);
		}
		.suggestion-item:last-child { border-bottom: none; }
		.suggestion-item:hover, .suggestion-item.selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
	`;
}

export function getWebviewScript(): string {
	return /* js */ `
		const vscode = acquireVsCodeApi();
		let currentAssistantMessage = null;
		let currentAssistantContentRaw = "";
		let thinkingEl = null;
		let isBusy = false;
		let assistantHasContent = false;
		let activeToolCalls = new Map();

		// Suggestions state
		let suggestionIndex = 0;
		let suggestionFiles = [];
		let mentionMatch = null;
		let currentSearchQuery = null;
		const suggestionsEl = document.getElementById('suggestions');

		const textarea = document.querySelector('textarea');
		const sendButton = document.getElementById('send-btn');

		function setBusy(state) {
			isBusy = state;
			if (sendButton) {
				sendButton.disabled = state;
				sendButton.textContent = state ? 'Working…' : 'Send';
			}
			if (textarea) {
				textarea.disabled = state;
			}
		}

		setBusy(false);

		// Configure Markdown
		if (window.marked && window.hljs) {
			window.marked.setOptions({
				highlight: function(code, lang) {
					if (lang && window.hljs.getLanguage(lang)) {
						return window.hljs.highlight(code, { language: lang }).value;
					}
					return window.hljs.highlightAuto(code).value;
				}
			});
		}

		// Restore history
		vscode.postMessage({ type: 'getHistory' });
		// Initial context
		vscode.postMessage({ type: 'getEditorContext' });

		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.type) {
				case 'contextUpdate':
					updateContextUI(message.data);
					break;
				case 'token':
					appendToken(message.value);
					break;
				case 'thinking_start':
					showThinking();
					break;
				case 'thinking_token':
					appendThinkingToken(message.value);
					break;
				case 'thinking_end':
					hideThinking();
					break;
				case 'tool_start':
					createToolCall(
						message.id,
						message.name,
						message.summaryLabel,
						message.args,
					);
					break;
				case 'tool_end':
					updateToolResult(message.id, message.result, message.isError);
					break;
				case 'approval_required':
					showApprovalRequest(message);
					break;
				case 'approval_resolved':
					updateApprovalStatus(message.requestId, message.decision);
					break;
				case 'runtime_status':
					setRuntimeStatus(message.value);
					break;
				case 'runtime_status_clear':
					clearRuntimeStatus();
					break;
				case 'done':
					clearRuntimeStatus();
					resetAssistantState();
					break;
				case 'error':
					clearRuntimeStatus();
					discardPendingAssistantMessage();
					showError(message.value);
					break;
				case 'history':
					loadHistory(message.messages);
					break;
				case 'clear':
					const list = document.getElementById('messages');
					if (list) {
						list.innerHTML = '';
					}
					resetAssistantState();
					activeToolCalls.clear();
					clearRuntimeStatus();
					setBusy(false);
					break;
				case 'busy':
					setBusy(Boolean(message.value));
					break;
				case 'searchResults':
					// Ignore stale results from earlier queries
					if (message.query === currentSearchQuery) {
						showSuggestions(message.files, message.query);
					}
					break;
			}
		});

		function updateContextUI(data) {
			const dot = document.getElementById('status-dot');
			const container = document.getElementById('context-bar');
			container.innerHTML = '';

			const active = data.activeFile;
			const pinned = data.pinnedFiles || [];

			if (active || pinned.length > 0) {
				dot.className = 'status-dot active';
			} else {
				dot.className = 'status-dot';
				container.innerHTML = '<span style="opacity: 0.7">No context</span>';
				return;
			}

			if (active) {
				const row = document.createElement('div');
				row.className = 'context-row';
				const labelSpan = document.createElement('span');
				labelSpan.style.opacity = '0.7';
				labelSpan.textContent = 'Active:';
				row.appendChild(labelSpan);
				row.appendChild(document.createTextNode(' ' + active.filename.split(/[\\\\/]/).pop()));
				if (active.selection) {
					const selectionPill = document.createElement('span');
					selectionPill.className = 'context-pill';
					selectionPill.textContent = 'Selection';
					row.appendChild(document.createTextNode(' '));
					row.appendChild(selectionPill);
				}
				container.appendChild(row);
			}

			if (pinned.length > 0) {
				const row = document.createElement('div');
				row.className = 'context-row';
				row.style.flexWrap = 'wrap';
				const pinnedLabel = document.createElement('span');
				pinnedLabel.style.opacity = '0.7';
				pinnedLabel.textContent = 'Pinned:';
				row.appendChild(pinnedLabel);
				pinned.forEach(p => {
					const pill = document.createElement('span');
					pill.className = 'context-pill';
					const nameNode = document.createTextNode(p.name + ' ');
					const removeButton = document.createElement('span');
					removeButton.className = 'remove-btn';
					removeButton.textContent = '×';
					removeButton.addEventListener('click', () => removePinned(p.path));
					pill.appendChild(nameNode);
					pill.appendChild(removeButton);
					row.appendChild(pill);
				});
				container.appendChild(row);
			}
		}

		function setRuntimeStatus(text) {
			const el = document.getElementById('runtime-status');
			if (!el) return;
			if (!text) {
				clearRuntimeStatus();
				return;
			}
			el.textContent = text;
			el.classList.add('visible');
		}

		function clearRuntimeStatus() {
			const el = document.getElementById('runtime-status');
			if (!el) return;
			el.textContent = '';
			el.classList.remove('visible');
		}

		window.removePinned = (path) => {
			vscode.postMessage({ type: 'removePinnedFile', path });
		};

		function renderMarkdown(text) {
			if (window.marked && window.DOMPurify) {
				return window.DOMPurify.sanitize(window.marked.parse(text));
			}
			return text.replace(/</g, '&lt;');
		}

		function loadHistory(messages) {
			const container = document.getElementById('messages');
			if (!container) return;
			container.innerHTML = '';
			messages.forEach(msg => {
				if (msg.role === 'toolResult') return;
				if (msg.role === 'tool') return;

				const div = document.createElement('div');
				div.className = 'message ' + msg.role;
				const avatar = document.createElement('div');
				avatar.className = 'avatar';
				avatar.textContent = msg.role === 'user' ? 'U' : 'AI';

				const content = document.createElement('div');
				content.className = 'message-content';
				if (msg.role === 'assistant') {
					content.innerHTML = renderMarkdown(msg.content || '');
					if (msg.tools && Array.isArray(msg.tools)) {
						msg.tools.forEach(tool => {
							const toolDiv = document.createElement('div');
							toolDiv.className = 'tool-call';
							toolDiv.innerHTML = \`
								<div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
									<span class="tool-name" title="\${tool.name}">\${tool.summaryLabel || tool.name}</span>
									<span class="tool-status">Completed</span>
								</div>
								<div class="tool-body">
									<div class="tool-section">
										<div class="tool-section-title">Tool</div>
										<div class="tool-code">\${tool.name}</div>
									</div>
									<div class="tool-section">
										<div class="tool-section-title">Arguments</div>
										<div class="tool-code">\${JSON.stringify(tool.args, null, 2)}</div>
									</div>
									<div class="tool-section">
										<div class="tool-section-title">Result</div>
										<div class="tool-code">\${JSON.stringify(tool.result, null, 2)}</div>
									</div>
								</div>
							\`;
							content.appendChild(toolDiv);
						});
					}
				} else {
					// User message: strip context block if present for display
					let text = msg.content || '';
					const delimiter = '<<< USER_MESSAGE_START >>>';
					if (text.includes(delimiter)) {
						const parts = text.split(delimiter);
						text = parts[parts.length - 1].trim();
					}
					content.textContent = text;
				}

				div.appendChild(avatar);
				div.appendChild(content);
				container.appendChild(div);
			});
			container.scrollTop = container.scrollHeight;
			resetAssistantState();
		}

		function showThinking() {
			if (!currentAssistantMessage) createAssistantMessage();
			if (thinkingEl) return;

			thinkingEl = document.createElement('div');
			thinkingEl.className = 'thinking';
			thinkingEl.innerHTML = 'Thinking<span class="thinking-dots"></span>';

			const content = currentAssistantMessage.querySelector('.message-content');
			if (content.firstChild) {
				content.insertBefore(thinkingEl, content.firstChild);
			} else {
				content.appendChild(thinkingEl);
			}
		}

		function appendThinkingToken(text) {
			if (!thinkingEl) showThinking();
		}

		function hideThinking() {
			if (thinkingEl) {
				thinkingEl.remove();
				thinkingEl = null;
			}
		}

		function createToolCall(id, name, summaryLabel, args) {
			if (!currentAssistantMessage) createAssistantMessage();
			const content = currentAssistantMessage.querySelector('.message-content');

			const toolDiv = document.createElement('div');
			toolDiv.className = 'tool-call';
			toolDiv.innerHTML = \`
				<div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
					<span class="tool-name" title="\${name}">\${summaryLabel || name}</span>
					<span class="tool-status">Running...</span>
				</div>
				<div class="tool-body">
					<div class="tool-section">
						<div class="tool-section-title">Tool</div>
						<div class="tool-code">\${name}</div>
					</div>
					<div class="tool-section">
						<div class="tool-section-title">Arguments</div>
						<div class="tool-code">\${JSON.stringify(args, null, 2)}</div>
					</div>
				</div>
			\`;
			content.appendChild(toolDiv);
			activeToolCalls.set(id, toolDiv);

			const messages = document.getElementById('messages');
			messages.scrollTop = messages.scrollHeight;
		}

		function updateToolResult(id, result, isError) {
			const toolDiv = activeToolCalls.get(id);
			if (!toolDiv) return;

			const status = toolDiv.querySelector('.tool-status');
			status.textContent = isError ? 'Error' : 'Completed';
			if (isError) status.style.color = '#ef4444';
			else status.style.color = '#10b981';

			const body = toolDiv.querySelector('.tool-body');
			const resultSection = document.createElement('div');
			resultSection.className = 'tool-section';

			let resultText = '';
			if (result && result.content && Array.isArray(result.content)) {
				resultText = result.content.map(c => c.text).join('\\n');
			} else {
				resultText = JSON.stringify(result, null, 2);
			}

			const titleEl = document.createElement('div');
			titleEl.className = 'tool-section-title';
			titleEl.textContent = 'Result';
			resultSection.appendChild(titleEl);

			const codeEl = document.createElement('div');
			codeEl.className = 'tool-code';
			codeEl.textContent = resultText;
			resultSection.appendChild(codeEl);

			body.appendChild(resultSection);
			activeToolCalls.delete(id);
		}

		function showApprovalRequest(msg) {
			if (!currentAssistantMessage) createAssistantMessage();
			const content = currentAssistantMessage.querySelector('.message-content');
			const toolTitle = msg.summaryLabel || msg.displayName || msg.toolName;
			const toolMeta =
				msg.displayName && msg.displayName !== msg.toolName
					? '<div class="approval-reason" style="margin-bottom: 8px">' + msg.toolName + '</div>'
					: '';
			const actionDescription = msg.actionDescription
				? '<div class="approval-reason">' + msg.actionDescription + '</div>'
				: '';

			const div = document.createElement('div');
			div.id = 'approval-' + msg.requestId;
			div.className = 'approval-request';
			div.innerHTML = \`
				<div class="approval-header">
					<span>Approval Required</span>
					<span class="tool-name">\${toolTitle}</span>
				</div>
				\${toolMeta}
				<div class="tool-code" style="margin-bottom: 8px; font-size: 11px">\${JSON.stringify(msg.args, null, 2)}</div>
				\${actionDescription}
				<div class="approval-reason">\${msg.reason || 'Requires confirmation'}</div>
				<div class="approval-actions">
					<button class="btn-approve" onclick="submitApproval('\${msg.requestId}', 'approved')">Approve</button>
					<button class="btn-deny" onclick="submitApproval('\${msg.requestId}', 'denied')">Deny</button>
				</div>
			\`;
			content.appendChild(div);
			const messages = document.getElementById('messages');
			messages.scrollTop = messages.scrollHeight;
		}

		function updateApprovalStatus(requestId, decision) {
			const div = document.getElementById('approval-' + requestId);
			if (!div) return;

			const isApproved = decision.approved;
			div.style.borderColor = isApproved ? '#10b981' : '#ef4444';
			div.innerHTML = \`
				<div class="approval-header">
					<span>\${isApproved ? 'Approved' : 'Denied'}</span>
					<span class="tool-name"></span>
				</div>
				<div class="approval-reason">\${decision.reason || ''}</div>
			\`;
		}

		window.submitApproval = (requestId, decision) => {
			const div = document.getElementById('approval-' + requestId);
			if (div) {
				const btns = div.querySelectorAll('button');
				btns.forEach(b => b.disabled = true);
				btns.forEach(b => b.textContent = 'Sending...');
			}
			vscode.postMessage({ type: 'submitApproval', requestId, decision });
		};

		function resetAssistantState() {
			currentAssistantMessage = null;
			currentAssistantContentRaw = '';
			assistantHasContent = false;
			hideThinking();
			activeToolCalls.clear();
		}

		function discardPendingAssistantMessage() {
			if (currentAssistantMessage && !assistantHasContent) {
				currentAssistantMessage.remove();
			}
			resetAssistantState();
		}

		function createAssistantMessage() {
			const messages = document.getElementById('messages');
			const div = document.createElement('div');
			div.className = 'message assistant';
			div.innerHTML = \`
				<div class="avatar">AI</div>
				<div class="message-content"></div>
			\`;
			messages.appendChild(div);
			currentAssistantMessage = div;
			currentAssistantContentRaw = '';
			assistantHasContent = false;
			messages.scrollTop = messages.scrollHeight;
			return div;
		}

		function appendToken(text) {
			if (!currentAssistantMessage) createAssistantMessage();
			currentAssistantContentRaw += text;
			assistantHasContent = true;

			const contentDiv = currentAssistantMessage.querySelector('.message-content');

			let textContainer = contentDiv.querySelector('.text-container');
			if (!textContainer) {
				textContainer = document.createElement('div');
				textContainer.className = 'text-container';
				if (thinkingEl && thinkingEl.parentElement === contentDiv) {
					contentDiv.insertBefore(textContainer, thinkingEl.nextSibling);
				} else {
					contentDiv.insertBefore(textContainer, contentDiv.firstChild);
				}
			}

			textContainer.innerHTML = renderMarkdown(currentAssistantContentRaw);

			const messages = document.getElementById('messages');
			messages.scrollTop = messages.scrollHeight;
		}

		function showError(text) {
			const messages = document.getElementById('messages');
			if (!messages) return;
			const div = document.createElement('div');
			div.className = 'message assistant';
			div.style.borderColor = '#ef4444';

			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			avatar.style.background = '#ef4444';
			avatar.textContent = '!';

			const content = document.createElement('div');
			content.className = 'message-content';
			content.textContent = text || '';

			div.appendChild(avatar);
			div.appendChild(content);
			messages.appendChild(div);
			messages.scrollTop = messages.scrollHeight;
		}

		function showSuggestions(files, query) {
			suggestionFiles = files;
			suggestionIndex = 0;
			suggestionsEl.innerHTML = '';
			if (files.length === 0) {
				suggestionsEl.classList.remove('visible');
				return;
			}

			files.forEach((file, i) => {
				const div = document.createElement('div');
				div.className = 'suggestion-item' + (i === 0 ? ' selected' : '');
				div.textContent = file;
				div.onclick = () => selectSuggestion(file);
				suggestionsEl.appendChild(div);
			});
			suggestionsEl.classList.add('visible');
		}

		function hideSuggestions() {
			suggestionsEl.classList.remove('visible');
			suggestionFiles = [];
			mentionMatch = null;
		}

		function updateSelectedSuggestion() {
			const items = suggestionsEl.children;
			for (let i = 0; i < items.length; i++) {
				if (i === suggestionIndex) items[i].classList.add('selected');
				else items[i].classList.remove('selected');
			}
			const selected = items[suggestionIndex];
			if (selected) {
				if (selected.offsetTop < suggestionsEl.scrollTop) {
					suggestionsEl.scrollTop = selected.offsetTop;
				} else if (selected.offsetTop + selected.offsetHeight > suggestionsEl.scrollTop + suggestionsEl.offsetHeight) {
					suggestionsEl.scrollTop = selected.offsetTop + selected.offsetHeight - suggestionsEl.offsetHeight;
				}
			}
		}

		function selectSuggestion(file) {
			if (!mentionMatch) return;
			const text = textarea.value;
			const before = text.slice(0, mentionMatch.start);
			const after = text.slice(mentionMatch.end);
			// Avoid double space if after already starts with space
			const spacer = after.startsWith(' ') ? '' : ' ';
			const newValue = before + '@' + file + spacer + after;
			textarea.value = newValue;
			textarea.focus();
			// Move cursor
			const newPos = before.length + file.length + 1 + spacer.length;
			textarea.setSelectionRange(newPos, newPos);

			hideSuggestions();
		}

		// Auto-resize textarea
		if (textarea) {
			textarea.addEventListener('input', function() {
				this.style.height = 'auto';
				this.style.height = (this.scrollHeight) + 'px';

				// Check for mention
				const cursor = this.selectionStart;
				const textBeforeCursor = this.value.slice(0, cursor);
				const match = /@([a-zA-Z0-9_\-\.\/]*)$/.exec(textBeforeCursor);

				if (match) {
					mentionMatch = {
						start: match.index,
						end: cursor,
						query: match[1]
					};
					currentSearchQuery = match[1];
					vscode.postMessage({ type: 'searchFiles', query: match[1] });
				} else {
					currentSearchQuery = null;
					hideSuggestions();
				}
			});
		}

		function sendMessage() {
			if (!textarea || isBusy) return;
			const text = textarea.value.trim();
			if (!text) return;

			const messages = document.getElementById('messages');
			if (messages) {
				const div = document.createElement('div');
				div.className = 'message user';

				const avatar = document.createElement('div');
				avatar.className = 'avatar';
				avatar.textContent = 'U';

				const content = document.createElement('div');
				content.className = 'message-content';
				content.textContent = text;

				div.appendChild(avatar);
				div.appendChild(content);
				messages.appendChild(div);
				messages.scrollTop = messages.scrollHeight;
			}

			textarea.value = '';
			textarea.style.height = 'auto';
			hideSuggestions();

			vscode.postMessage({ type: 'sendMessage', text });
		}

		if (sendButton) {
			sendButton.addEventListener('click', sendMessage);
		}

		if (textarea) {
			textarea.addEventListener('keydown', (e) => {
				if (suggestionsEl.classList.contains('visible')) {
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						suggestionIndex = (suggestionIndex + 1) % suggestionFiles.length;
						updateSelectedSuggestion();
						return;
					}
					if (e.key === 'ArrowUp') {
						e.preventDefault();
						suggestionIndex = (suggestionIndex - 1 + suggestionFiles.length) % suggestionFiles.length;
						updateSelectedSuggestion();
						return;
					}
					if (e.key === 'Enter' || e.key === 'Tab') {
						e.preventDefault();
						selectSuggestion(suggestionFiles[suggestionIndex]);
						return;
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						hideSuggestions();
						return;
					}
				}

				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					sendMessage();
				}
			});
		}
	`;
}

export function getWebviewHtml(options: WebviewTemplateOptions): string {
	const { nonce, vendorUri, styleUri, cspSource, cspConnect } = options;

	return /* html */ `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspConnect} https: http: wss: ws:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Maestro Chat</title>
			<link href="${styleUri}" rel="stylesheet">
			<style>${getWebviewStyles()}</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<h2>Maestro Agent</h2>
					<div id="status-dot" class="status-dot"></div>
				</div>
				<div id="runtime-status" class="runtime-status"></div>

				<div id="context-bar" class="context-bar">
					<!-- Populated by JS -->
				</div>

				<div class="messages" id="messages"></div>

				<div class="input-area">
					<div class="input-container">
						<div id="suggestions" class="suggestions"></div>
						<textarea placeholder="Ask anything... (Enter to send)" rows="1"></textarea>
						<div class="input-actions">
							<span style="font-size: 10px; color: var(--text-secondary); display: flex; align-items: center;">
								↵ to send
							</span>
							<button id="send-btn">Send</button>
						</div>
					</div>
				</div>
			</div>

			<script src="${vendorUri}"></script>
			<script nonce="${nonce}">${getWebviewScript()}</script>
		</body>
		</html>`;
}
