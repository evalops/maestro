export function generateSandboxBridgeCode(sandboxId: string): string {
	return `
(function() {
  const __sandboxId = ${JSON.stringify(sandboxId)};

  window.postRuntimeMessage = (message) => {
    try {
      window.parent.postMessage({ ...message, sandboxId: __sandboxId }, "*");
    } catch (_) {
      // ignore
    }
  };

  window.sendRuntimeMessage = async (message, opts) => {
    const timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : 10000;
    const messageId = "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);

    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (e) => {
        if (!e || !e.data) return;
        if (e.data.type !== "runtime-response") return;
        if (e.data.sandboxId !== __sandboxId) return;
        if (e.data.messageId !== messageId) return;
        if (done) return;
        done = true;
        window.removeEventListener("message", handler);
        resolve(e.data);
      };

      window.addEventListener("message", handler);

      try {
        window.parent.postMessage({ ...message, sandboxId: __sandboxId, messageId }, "*");
      } catch (err) {
        done = true;
        window.removeEventListener("message", handler);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", handler);
        reject(new Error("Runtime message timeout"));
      }, timeoutMs);
    });
  };
})();
`.trim();
}
