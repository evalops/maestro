type ModeledFile = {
	lines: string[];
	finalNewline: boolean;
};

export type ApplyPatchFuzzCase = {
	initialFiles: Record<string, string>;
	expectedFiles: Record<string, string>;
	expectedTouchedPaths: string[];
	patch: string;
};

type ModelState = Map<string, ModeledFile>;

const INITIAL_FILES: Record<string, string> = {
	"alpha.txt": "alpha:0\nalpha:1\nalpha:2\n",
	"beta.txt": "beta:0\nbeta:1\nbeta:2",
	"nested/gamma.txt": "gamma:0\n",
};

export function makeApplyPatchFuzzCase(choices: number[]): ApplyPatchFuzzCase {
	const state = new Map(
		Object.entries(INITIAL_FILES).map(([path, content]) => [
			path,
			parseContent(content),
		]),
	);
	const patchLines = ["*** Begin Patch"];
	const touchedPaths: string[] = [];
	const addOperation = (path: string, lines: string[]) => {
		patchLines.push(`*** Add File: ${path}`);
		for (const line of lines) {
			patchLines.push(`+${line}`);
		}
		touch(touchedPaths, path);
	};
	const updateOperation = (
		path: string,
		bodyLines: string[],
		moveTo?: string,
	) => {
		patchLines.push(`*** Update File: ${path}`);
		if (moveTo) {
			patchLines.push(`*** Move to: ${moveTo}`);
		}
		patchLines.push("@@");
		patchLines.push(...bodyLines);
		touch(touchedPaths, path);
		if (moveTo) {
			touch(touchedPaths, moveTo);
		}
	};
	const deleteOperation = (path: string) => {
		patchLines.push(`*** Delete File: ${path}`);
		touch(touchedPaths, path);
	};

	for (const [step, choice] of choices.entries()) {
		const operation = choice % 7;
		if (operation === 0) {
			const path = pickExistingPath(state, choice + step);
			const file = state.get(path);
			if (!file || file.lines.length === 0) {
				continue;
			}
			const lineIndex = choice % file.lines.length;
			const oldLine = file.lines[lineIndex] ?? "";
			const newLine = `replace:${step}:${choice}`;
			updateOperation(path, [`-${oldLine}`, `+${newLine}`]);
			file.lines[lineIndex] = newLine;
			continue;
		}

		if (operation === 1) {
			const path = pickExistingPath(state, choice + step);
			const file = state.get(path);
			if (!file) {
				continue;
			}
			const newLine = `append:${step}:${choice}`;
			updateOperation(path, [`+${newLine}`]);
			file.lines.push(newLine);
			continue;
		}

		if (operation === 2) {
			const path = `generated/add-${step}-${choice}.txt`;
			if (state.has(path)) {
				continue;
			}
			const lines = [`created:${step}`, `choice:${choice}`];
			addOperation(path, lines);
			state.set(path, { lines, finalNewline: true });
			continue;
		}

		if (operation === 3) {
			const path = pickDeletablePath(state, choice + step);
			if (!path) {
				continue;
			}
			deleteOperation(path);
			state.delete(path);
			continue;
		}

		if (operation === 4) {
			const sourcePath = pickExistingPath(state, choice + step);
			const file = state.get(sourcePath);
			const destinationPath = `generated/move-${step}-${choice}.txt`;
			if (!file || state.has(destinationPath)) {
				continue;
			}
			const oldLine = file.lines[0] ?? "";
			const newLine = `moved:${step}:${choice}`;
			const bodyLines =
				file.lines.length > 0 ? [`-${oldLine}`, `+${newLine}`] : [];
			updateOperation(sourcePath, bodyLines, destinationPath);
			const nextFile = {
				lines: [...file.lines],
				finalNewline: file.finalNewline,
			};
			if (nextFile.lines.length > 0) {
				nextFile.lines[0] = newLine;
			}
			state.delete(sourcePath);
			state.set(destinationPath, nextFile);
			continue;
		}

		if (operation === 5) {
			const path = findPathByFinalNewline(state, false);
			const file = path ? state.get(path) : undefined;
			if (!path || !file || file.lines.length === 0) {
				continue;
			}
			const oldLine = file.lines.at(-1) ?? "";
			const newLine = `add-final-newline:${step}:${choice}`;
			updateOperation(path, [
				`-${oldLine}`,
				"\\ No newline at end of file",
				`+${newLine}`,
			]);
			file.lines[file.lines.length - 1] = newLine;
			file.finalNewline = true;
			continue;
		}

		const path = findPathByFinalNewline(state, true);
		const file = path ? state.get(path) : undefined;
		if (!path || !file || file.lines.length === 0) {
			continue;
		}
		const oldLine = file.lines.at(-1) ?? "";
		const newLine = `remove-final-newline:${step}:${choice}`;
		updateOperation(path, [
			`-${oldLine}`,
			`+${newLine}`,
			"\\ No newline at end of file",
		]);
		file.lines[file.lines.length - 1] = newLine;
		file.finalNewline = false;
	}

	if (patchLines.length === 1) {
		addOperation("generated/fallback.txt", ["fallback"]);
		state.set("generated/fallback.txt", {
			lines: ["fallback"],
			finalNewline: true,
		});
	}
	patchLines.push("*** End Patch");

	return {
		initialFiles: sortRecord(INITIAL_FILES),
		expectedFiles: serializeState(state),
		expectedTouchedPaths: touchedPaths,
		patch: patchLines.join("\n"),
	};
}

function parseContent(content: string): ModeledFile {
	const finalNewline = content.endsWith("\n");
	const body = finalNewline ? content.slice(0, -1) : content;
	return {
		lines: body.length === 0 ? [] : body.split("\n"),
		finalNewline,
	};
}

function serializeFile(file: ModeledFile): string {
	if (file.lines.length === 0) {
		return "";
	}
	const content = file.lines.join("\n");
	return file.finalNewline ? `${content}\n` : content;
}

function serializeState(state: ModelState): Record<string, string> {
	return sortRecord(
		Object.fromEntries(
			[...state.entries()].map(([path, file]) => [path, serializeFile(file)]),
		),
	);
}

function sortRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function pickExistingPath(state: ModelState, choice: number): string {
	const paths = [...state.keys()].sort();
	return paths[choice % paths.length] ?? "alpha.txt";
}

function pickDeletablePath(state: ModelState, choice: number): string | null {
	const paths = [...state.keys()]
		.filter((path) => path.startsWith("generated/"))
		.sort();
	if (paths.length === 0) {
		return null;
	}
	return paths[choice % paths.length] ?? null;
}

function findPathByFinalNewline(
	state: ModelState,
	finalNewline: boolean,
): string | null {
	return (
		[...state.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.find(
				([, file]) =>
					file.finalNewline === finalNewline && file.lines.length > 0,
			)?.[0] ?? null
	);
}

function touch(paths: string[], path: string): void {
	if (!paths.includes(path)) {
		paths.push(path);
	}
}
