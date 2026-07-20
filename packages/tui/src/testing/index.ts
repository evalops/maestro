/**
 * @fileoverview Testing Utilities for @evalops/tui
 *
 * This module provides utilities for testing TUI components and applications.
 * It is exported separately to avoid bundling test dependencies in production.
 *
 * ## Installation
 *
 * The VirtualTerminal requires @xterm/headless as a dev dependency:
 *
 * ```bash
 * npm install -D @xterm/headless
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { VirtualTerminal } from "@evalops/tui/testing";
 * import { TUI, Text } from "@evalops/tui";
 *
 * describe("my component", () => {
 *   let term: VirtualTerminal;
 *
 *   beforeEach(() => {
 *     term = new VirtualTerminal(80, 24);
 *   });
 *
 *   afterEach(() => {
 *     term.dispose();
 *   });
 *
 *   it("renders correctly", async () => {
 *     const tui = new TUI(term);
 *     tui.addChild(new Text("Hello World"));
 *     tui.start();
 *
 *     const lines = await term.flushAndGetViewport();
 *     expect(lines[0]).toContain("Hello World");
 *   });
 * });
 * ```
 *
 * @module @evalops/tui/testing
 */

export { VirtualTerminal } from "./virtual-terminal.js";
