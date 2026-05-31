export type ApplyPatchHunk = {
	oldLines: string[];
	newLines: string[];
	oldNoFinalNewline?: boolean;
	newNoFinalNewline?: boolean;
	oldMustEndAtEOF?: boolean;
};

export type ApplyPatchOperation =
	| {
			type: "add";
			path: string;
			lines: string[];
	  }
	| {
			type: "delete";
			path: string;
	  }
	| {
			type: "update";
			path: string;
			moveTo?: string;
			hunks: ApplyPatchHunk[];
	  };

export type ApplyPatchDocument = {
	operations: ApplyPatchOperation[];
};

export function parseApplyPatchPaths(patch: string): string[] {
	try {
		return [
			...new Set(
				parseApplyPatch(patch).operations.flatMap((operation) =>
					operation.type === "update" && operation.moveTo
						? [operation.path, operation.moveTo]
						: [operation.path],
				),
			),
		];
	} catch {
		return [];
	}
}

export function parseApplyPatch(patch: string): ApplyPatchDocument {
	const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	if (lines[0] !== "*** Begin Patch") {
		throw new Error("apply_patch must start with *** Begin Patch");
	}
	if (lines.at(-1) !== "*** End Patch") {
		throw new Error("apply_patch must end with *** End Patch");
	}

	const operations: ApplyPatchOperation[] = [];
	let index = 1;
	const endIndex = lines.length - 1;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (line.startsWith("*** Add File: ")) {
			const path = requirePatchPath(line.slice("*** Add File: ".length));
			index++;
			const addLines: string[] = [];
			while (index < endIndex && !isOperationHeader(lines[index] ?? "")) {
				const bodyLine = lines[index] ?? "";
				if (!bodyLine.startsWith("+")) {
					throw new Error(
						`Add File ${path} contains a non-added line: ${bodyLine}`,
					);
				}
				addLines.push(bodyLine.slice(1));
				index++;
			}
			if (addLines.length === 0) {
				throw new Error(`Add File ${path} must contain at least one line`);
			}
			operations.push({ type: "add", path, lines: addLines });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			operations.push({
				type: "delete",
				path: requirePatchPath(line.slice("*** Delete File: ".length)),
			});
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const path = requirePatchPath(line.slice("*** Update File: ".length));
			index++;
			let moveTo: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				moveTo = requirePatchPath(
					(lines[index] ?? "").slice("*** Move to: ".length),
				);
				index++;
			}
			const hunks: ApplyPatchHunk[] = [];
			while (index < endIndex && !isOperationHeader(lines[index] ?? "")) {
				if ((lines[index] ?? "").startsWith("@@")) {
					index++;
				}
				const hunk: ApplyPatchHunk = { oldLines: [], newLines: [] };
				let previousPrefix: string | undefined;
				while (index < endIndex) {
					const bodyLine = lines[index] ?? "";
					if (bodyLine.startsWith("@@") || isOperationHeader(bodyLine)) {
						break;
					}
					if (bodyLine.startsWith("*** Move to: ")) {
						throw new Error(
							`Update File ${path} must place Move to before hunks`,
						);
					}
					if (bodyLine === "\\ No newline at end of file") {
						if (previousPrefix === "-" || previousPrefix === " ") {
							hunk.oldNoFinalNewline = true;
						}
						if (previousPrefix === "+" || previousPrefix === " ") {
							hunk.newNoFinalNewline = true;
						}
						index++;
						continue;
					}
					if (bodyLine === "*** End of File") {
						hunk.oldMustEndAtEOF = true;
						index++;
						continue;
					}
					const prefix = bodyLine[0];
					const content = bodyLine.slice(1);
					if (prefix === " ") {
						hunk.oldLines.push(content);
						hunk.newLines.push(content);
					} else if (prefix === "-") {
						hunk.oldLines.push(content);
					} else if (prefix === "+") {
						hunk.newLines.push(content);
					} else {
						throw new Error(
							`Update File ${path} contains an invalid hunk line: ${bodyLine}`,
						);
					}
					previousPrefix = prefix;
					index++;
				}
				if (hunk.oldLines.length === 0 && hunk.newLines.length === 0) {
					throw new Error(`Update File ${path} contains an empty hunk`);
				}
				hunks.push(hunk);
			}
			if (hunks.length === 0 && !moveTo) {
				throw new Error(`Update File ${path} must contain at least one hunk`);
			}
			operations.push({
				type: "update",
				path,
				...(moveTo ? { moveTo } : {}),
				hunks,
			});
			continue;
		}

		throw new Error(`Unknown apply_patch operation: ${line}`);
	}

	if (operations.length === 0) {
		throw new Error("apply_patch must contain at least one file operation");
	}
	return { operations };
}

function requirePatchPath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) {
		throw new Error("apply_patch operation is missing a file path");
	}
	return trimmed;
}

function isOperationHeader(line: string): boolean {
	return (
		line.startsWith("*** Add File: ") ||
		line.startsWith("*** Update File: ") ||
		line.startsWith("*** Delete File: ")
	);
}
