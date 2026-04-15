/**
 * Sandboxed iframe renderer for HTML artifacts / previews.
 *
 * Ported from pi-mono's web-ui sandbox runtime:
 * - Tight iframe sandbox (no same-origin)
 * - postMessage runtime bridge
 * - Centralized message router singleton
 * - Explicit runtime providers (artifacts, console, etc.)
 */

import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { clearSandboxConsoleSnapshot } from "./sandbox/console-runtime-provider.js";
import { ConsoleRuntimeProvider } from "./sandbox/console-runtime-provider.js";
import { generateSandboxBridgeCode } from "./sandbox/runtime-message-bridge.js";
import {
	type MessageConsumer,
	RUNTIME_MESSAGE_ROUTER,
} from "./sandbox/runtime-message-router.js";
import type { SandboxRuntimeProvider } from "./sandbox/sandbox-runtime-provider.js";

function escapeScriptContent(code: string): string {
	return code.replace(/<\/script/gi, "<\\/script");
}

function isSafeExternalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function wrapHtmlDocument(htmlContent: string): string {
	const trimmed = htmlContent.trim();
	const looksLikeDocument =
		/^<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed);

	if (looksLikeDocument) {
		return trimmed;
	}

	return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { height: 100%; margin: 0; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    </style>
  </head>
  <body>
${trimmed}
  </body>
</html>`;
}

@customElement("composer-sandboxed-iframe")
export class ComposerSandboxedIframe extends LitElement {
	static override styles = css`
		:host {
			display: block;
			width: 100%;
			height: 320px;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-deep, #08090a);
		}

		iframe {
			width: 100%;
			height: 100%;
			border: 0;
			display: block;
			background: #fff;
		}
	`;

	@property() sandboxId = "";
	@property({ attribute: false }) htmlContent = "";
	@property({ attribute: false }) providers: SandboxRuntimeProvider[] = [];
	@property({ attribute: false }) consumers: MessageConsumer[] = [];

	@query("iframe") private iframe?: HTMLIFrameElement;

	private readonly openExternalUrlConsumer: MessageConsumer = {
		handleMessage: async (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const m = message as Record<string, unknown>;
			if (m.type !== "open-external-url") return;
			const url = m.url;
			if (typeof url !== "string" || url.trim().length === 0) return;
			if (!isSafeExternalUrl(url)) return;
			window.open(url, "_blank", "noopener,noreferrer");
		},
	};

	override connectedCallback(): void {
		super.connectedCallback();
		if (this.sandboxId) {
			RUNTIME_MESSAGE_ROUTER.registerSandbox(
				this.sandboxId,
				[new ConsoleRuntimeProvider(), ...(this.providers ?? [])],
				[this.openExternalUrlConsumer, ...(this.consumers ?? [])],
			);
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.sandboxId) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(this.sandboxId);
		}
	}

	protected override updated(
		changed: Map<string | number | symbol, unknown>,
	): void {
		const id = this.sandboxId || "";
		if (!id) return;

		if (changed.has("sandboxId")) {
			const oldId = changed.get("sandboxId");
			if (typeof oldId === "string" && oldId.length > 0 && oldId !== id) {
				RUNTIME_MESSAGE_ROUTER.unregisterSandbox(oldId);
				clearSandboxConsoleSnapshot(oldId);
			}
		}

		if (
			changed.has("sandboxId") ||
			changed.has("providers") ||
			changed.has("consumers")
		) {
			RUNTIME_MESSAGE_ROUTER.registerSandbox(
				id,
				[new ConsoleRuntimeProvider(), ...(this.providers ?? [])],
				[this.openExternalUrlConsumer, ...(this.consumers ?? [])],
			);
		}

		if (changed.has("sandboxId") || changed.has("htmlContent")) {
			clearSandboxConsoleSnapshot(id);
		}

		if (this.iframe) {
			RUNTIME_MESSAGE_ROUTER.setSandboxIframe(id, this.iframe);
		}

		if (
			this.iframe &&
			(changed.has("sandboxId") ||
				changed.has("htmlContent") ||
				changed.has("providers"))
		) {
			this.iframe.srcdoc = this.buildSrcdoc();
		}
	}

	private buildSrcdoc(): string {
		const userProviders = Array.isArray(this.providers) ? this.providers : [];
		const providers: SandboxRuntimeProvider[] = [
			new ConsoleRuntimeProvider(),
			...userProviders,
		];
		const data: Record<string, unknown> = {};
		const runtimes: string[] = [];

		for (const provider of providers) {
			Object.assign(data, provider.getData());
			runtimes.push(provider.getRuntime().toString());
		}

		const userHtml = wrapHtmlDocument(this.htmlContent);
		const bridge = generateSandboxBridgeCode(this.sandboxId || "sandbox");

		const navInterceptor = `
(function() {
  const post = window.postRuntimeMessage || ((m) => {
    try { window.parent.postMessage(m, "*"); } catch (_) {}
  });

  const openExternal = (url) => {
    try { post({ type: "open-external-url", url }); } catch (_) {}
  };

  const isHttpUrl = (url) => /^https?:\\/\\//i.test(url || "");

  const originalOpen = window.open;
  window.open = function(url) {
    const u = String(url || "");
    if (isHttpUrl(u)) {
      openExternal(u);
      return null;
    }
    try { return originalOpen.apply(window, arguments); } catch (_) { return null; }
  };

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    const a = target.closest ? target.closest("a") : null;
    if (!a || !a.href) return;
    const href = a.href;
    const wantsNewTab = a.target === "_blank" || e.metaKey || e.ctrlKey;
    if (wantsNewTab && isHttpUrl(href)) {
      e.preventDefault();
      e.stopPropagation();
      openExternal(href);
    }
  }, true);
})();
`.trim();

		const injected = `
<script>
  (function() {
    const sandboxId = ${JSON.stringify(this.sandboxId || "sandbox")};
    const data = ${escapeScriptContent(JSON.stringify(data))};
    for (const [k, v] of Object.entries(data)) {
      try { window[k] = v; } catch (_) {}
    }
    try { ${escapeScriptContent(bridge)} } catch (_) {}
    try { ${escapeScriptContent(navInterceptor)} } catch (_) {}
    ${runtimes
			.map((fnSource) => escapeScriptContent(fnSource))
			.map(
				(fnSource) => `
    try { (${fnSource})(sandboxId); } catch (e) { /* ignore */ }
    `,
			)
			.join("\n")}
  })();
</script>`;

		// Insert injected runtime just before </body> if present; else append.
		if (/<\/body>/i.test(userHtml)) {
			return userHtml.replace(/<\/body>/i, `${injected}\n</body>`);
		}
		return `${userHtml}\n${injected}`;
	}

	override render() {
		return html`<iframe
			sandbox="allow-scripts allow-modals allow-downloads"
			.referrerPolicy=${"no-referrer"}
		></iframe>`;
	}
}
