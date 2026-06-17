/**
 * Accessibility snapshot primitive
 *
 * The browser tool surface today is selector-driven: callers reason
 * over CSS selectors that the model cannot see. This module flips that
 * around. A snapshot is the agent-visible view of a page: a compact,
 * role-typed tree where every interactive node carries a stable ref
 * (`@e1`, `@e2`, …). The model picks a ref, the tool layer dispatches
 * the click/fill against that ref, then the page is re-snapshotted.
 *
 * What's here:
 *   - `A11yNode` / `A11ySnapshot` types
 *   - `allocateRefs` — walks an unrefined tree and assigns `@eN` ids to
 *     interactive nodes (configurable predicate; defaults match WAI-ARIA
 *     interactive widget roles)
 *   - `resolveRef` — `@eN` → node, or null if stale
 *   - `findByRole` — locator fallback when a ref isn't known
 *   - `renderCompact` — string view used as the model-facing payload
 *   - `isStaleRef` — snapshot-mutation guard
 *
 * What's NOT here: CDP integration, browser process spawning, the
 * actual `snapshot` tool, mutation observers. Those ride later PRs that
 * consume this shape.
 */

/** Interactive widget roles that get a `@eN` ref by default. */
export const DEFAULT_INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"switch",
	"tab",
	"slider",
	"spinbutton",
]);

/** One node in the accessibility tree (pre-ref-allocation shape). */
export interface A11yNodeInput {
	/** WAI-ARIA role, e.g. `"button"`, `"link"`, `"heading"`. */
	role: string;
	/** Accessible name (label, button text, etc). May be empty. */
	name?: string;
	/** Optional URL for link nodes. */
	href?: string;
	/** Optional value (input text, slider position). */
	value?: string;
	/** Disabled / pressed / checked / expanded state flags. */
	state?: A11yNodeState;
	/** Children. */
	children?: A11yNodeInput[];
}

/** Boolean / tri-state widget flags. */
export interface A11yNodeState {
	disabled?: boolean;
	pressed?: boolean | "mixed";
	checked?: boolean | "mixed";
	expanded?: boolean;
	selected?: boolean;
	required?: boolean;
}

/** Node with an allocated `@eN` ref (if interactive). */
export interface A11yNode {
	role: string;
	name?: string;
	href?: string;
	value?: string;
	state?: A11yNodeState;
	/** Allocated ref like `"@e3"`. Present only for interactive nodes. */
	ref?: string;
	children: A11yNode[];
}

/** Top-level snapshot. */
export interface A11ySnapshot {
	/** Schema version. */
	version: number;
	/** Root node of the tree. */
	root: A11yNode;
	/** URL the snapshot was captured from. */
	url: string;
	/** Page title at capture time. */
	title?: string;
	/** ISO 8601 timestamp of capture. */
	capturedAt: string;
	/**
	 * Monotonic page-mutation counter. Each fresh snapshot of the same
	 * URL bumps this; refs from snapshot N are stale in snapshot N+1
	 * unless the caller re-resolves them.
	 */
	mutationCounter: number;
	/**
	 * `@eN` → node lookup. Allocated by `allocateRefs`. Empty when the
	 * tree has no interactive nodes.
	 */
	refIndex: ReadonlyMap<string, A11yNode>;
}

export const A11Y_SNAPSHOT_VERSION = 1;

/** Options controlling which nodes get `@eN` refs and tree pruning. */
export interface AllocateRefsOptions {
	/**
	 * Predicate that decides whether a node is interactive (gets a ref).
	 * Defaults to roles in `DEFAULT_INTERACTIVE_ROLES`.
	 */
	isInteractive?: (node: A11yNodeInput) => boolean;
	/**
	 * Optional starting ref index. Defaults to 1 (`@e1`). Useful when
	 * stitching snapshots across iframes.
	 */
	startIndex?: number;
}

/**
 * Walk `root` depth-first and produce an `A11ySnapshot`. Refs are
 * allocated in pre-order so the model sees `@e1` near the top of the
 * compact render.
 */
export function buildSnapshot(
	root: A11yNodeInput,
	options: {
		url: string;
		title?: string;
		capturedAt?: string;
		mutationCounter?: number;
		allocate?: AllocateRefsOptions;
	},
): A11ySnapshot {
	const allocate = options.allocate ?? {};
	const isInteractive = allocate.isInteractive ?? defaultInteractivePredicate;
	const refIndex = new Map<string, A11yNode>();
	let nextIndex = allocate.startIndex ?? 1;

	function visit(input: A11yNodeInput): A11yNode {
		const node: A11yNode = {
			role: input.role,
			children: [],
		};
		if (input.name !== undefined) node.name = input.name;
		if (input.href !== undefined) node.href = input.href;
		if (input.value !== undefined) node.value = input.value;
		if (input.state !== undefined) node.state = input.state;
		if (isInteractive(input)) {
			const ref = `@e${nextIndex}`;
			nextIndex += 1;
			node.ref = ref;
			refIndex.set(ref, node);
		}
		node.children = (input.children ?? []).map(visit);
		return node;
	}

	const builtRoot = visit(root);

	return {
		version: A11Y_SNAPSHOT_VERSION,
		root: builtRoot,
		url: options.url,
		title: options.title,
		capturedAt: options.capturedAt ?? new Date().toISOString(),
		mutationCounter: options.mutationCounter ?? 0,
		refIndex,
	};
}

function defaultInteractivePredicate(node: A11yNodeInput): boolean {
	return DEFAULT_INTERACTIVE_ROLES.has(node.role);
}

/** Look up a node by ref. Returns `undefined` if the ref is unknown. */
export function resolveRef(
	snapshot: A11ySnapshot,
	ref: string,
): A11yNode | undefined {
	return snapshot.refIndex.get(ref);
}

/**
 * True when the ref doesn't exist in `snapshot`. Use this after a
 * page-mutating action to detect a stale ref before re-dispatching.
 */
export function isStaleRef(snapshot: A11ySnapshot, ref: string): boolean {
	return !snapshot.refIndex.has(ref);
}

/** Locator fallback when the model doesn't have a fresh ref. */
export interface FindByRoleOptions {
	/** Exact `name` match (case-insensitive). */
	name?: string;
	/** Substring `name` match (case-insensitive). Ignored if `name` is set. */
	nameContains?: string;
}

/**
 * Pre-order walk of the tree, return the first node whose role matches
 * (and name matches, if supplied). Used as a fallback when the model
 * has lost track of the ref.
 */
export function findByRole(
	snapshot: A11ySnapshot,
	role: string,
	options: FindByRoleOptions = {},
): A11yNode | undefined {
	const wantName = options.name?.toLowerCase();
	const wantContains = options.nameContains?.toLowerCase();
	function walk(node: A11yNode): A11yNode | undefined {
		if (node.role === role) {
			const name = node.name?.toLowerCase() ?? "";
			if (wantName !== undefined) {
				if (name === wantName) return node;
			} else if (wantContains !== undefined) {
				if (name.includes(wantContains)) return node;
			} else {
				return node;
			}
		}
		for (const child of node.children) {
			const hit = walk(child);
			if (hit) return hit;
		}
		return undefined;
	}
	return walk(snapshot.root);
}

/** Options for the compact text render fed to the model. */
export interface RenderCompactOptions {
	/** Include `href` next to link nodes. Defaults to false. */
	includeHrefs?: boolean;
	/** Max depth to render. 0 = root only. Defaults to unbounded. */
	maxDepth?: number;
	/** Indent unit. Defaults to two spaces. */
	indent?: string;
}

/**
 * Render the snapshot as the model-facing string. One node per line,
 * indented by depth, in the shape:
 *
 *   `@e3 button "Submit"` (interactive)
 *   `heading "Welcome"`  (informational)
 *
 * Disabled / pressed / checked state flags are appended in brackets:
 *
 *   `@e7 checkbox "Remember me" [checked]`
 */
export function renderCompact(
	snapshot: A11ySnapshot,
	options: RenderCompactOptions = {},
): string {
	const lines: string[] = [];
	const indent = options.indent ?? "  ";
	const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;

	function emit(node: A11yNode, depth: number) {
		if (depth > maxDepth) return;
		const parts: string[] = [];
		if (node.ref) parts.push(node.ref);
		parts.push(node.role);
		if (node.name !== undefined && node.name !== "") {
			parts.push(JSON.stringify(node.name));
		}
		if (options.includeHrefs && node.href) {
			parts.push(`href=${JSON.stringify(node.href)}`);
		}
		if (node.value !== undefined && node.value !== "") {
			parts.push(`value=${JSON.stringify(node.value)}`);
		}
		const stateBits = stateToBits(node.state);
		if (stateBits.length > 0) {
			parts.push(`[${stateBits.join(" ")}]`);
		}
		lines.push(indent.repeat(depth) + parts.join(" "));
		for (const child of node.children) {
			emit(child, depth + 1);
		}
	}

	emit(snapshot.root, 0);
	return lines.join("\n");
}

function stateToBits(state: A11yNodeState | undefined): string[] {
	if (!state) return [];
	const bits: string[] = [];
	if (state.disabled) bits.push("disabled");
	if (state.required) bits.push("required");
	if (state.pressed !== undefined) {
		bits.push(
			state.pressed === "mixed"
				? "pressed=mixed"
				: state.pressed
					? "pressed"
					: "unpressed",
		);
	}
	if (state.checked !== undefined) {
		bits.push(
			state.checked === "mixed"
				? "checked=mixed"
				: state.checked
					? "checked"
					: "unchecked",
		);
	}
	if (state.expanded !== undefined) {
		bits.push(state.expanded ? "expanded" : "collapsed");
	}
	if (state.selected !== undefined) {
		bits.push(state.selected ? "selected" : "unselected");
	}
	return bits;
}

/**
 * Returns the list of refs in the snapshot, in allocation order. Useful
 * for "the model produced @e5 but the snapshot has @e1..@e3" diagnostics.
 */
export function listRefs(snapshot: A11ySnapshot): string[] {
	return Array.from(snapshot.refIndex.keys());
}
