import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagesDir = join(repoRoot, "packages");
const allowedOutside = [
	{
		filePrefix: join(packagesDir, "ai", "src") + sep,
		allowedPrefixes: [join(repoRoot, "src") + sep],
	},
	{
		filePrefix: join(packagesDir, "core", "src") + sep,
		allowedPrefixes: [join(repoRoot, "src") + sep],
	},
	{
		filePrefix: join(packagesDir, "governance", "src") + sep,
		allowedPrefixes: [join(repoRoot, "src") + sep],
	},
];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirs = new Set(["dist", "node_modules", ".external"]);

function isSubpath(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isAllowedOutside(filePath, resolvedPath) {
	return allowedOutside.some((rule) => {
		if (!filePath.startsWith(rule.filePrefix)) {
			return false;
		}
		return rule.allowedPrefixes.some((prefix) => resolvedPath.startsWith(prefix));
	});
}

function resolveImportPath(fromFile, specifier) {
	let resolved = resolve(dirname(fromFile), specifier);
	if (existsSync(resolved)) {
		return resolved;
	}

	for (const ext of sourceExtensions) {
		const withExt = resolved + ext;
		if (existsSync(withExt)) {
			return withExt;
		}
	}

	for (const ext of sourceExtensions) {
		const indexPath = join(resolved, `index${ext}`);
		if (existsSync(indexPath)) {
			return indexPath;
		}
	}

	return resolved;
}

function walk(dir, files = []) {
	if (!existsSync(dir)) {
		return files;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (ignoredDirs.has(entry.name)) {
				continue;
			}
			walk(join(dir, entry.name), files);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		if (!sourceExtensions.has(extname(entry.name))) {
			continue;
		}
		files.push(join(dir, entry.name));
	}
	return files;
}

function collectSpecifiers(filePath, sourceText) {
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
	);
	const specifiers = [];

	const visit = (node) => {
		if (
			ts.isImportDeclaration(node) ||
			ts.isExportDeclaration(node)
		) {
			if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				specifiers.push(node.moduleSpecifier.text);
			}
		}

		if (ts.isImportEqualsDeclaration(node)) {
			const ref = node.moduleReference;
			if (
				ts.isExternalModuleReference(ref) &&
				ref.expression &&
				ts.isStringLiteral(ref.expression)
			) {
				specifiers.push(ref.expression.text);
			}
		}

		if (ts.isCallExpression(node)) {
			if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require" &&
				node.arguments.length === 1 &&
				ts.isStringLiteral(node.arguments[0])
			) {
				specifiers.push(node.arguments[0].text);
			}
			if (
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments.length >= 1 &&
				ts.isStringLiteral(node.arguments[0])
			) {
				specifiers.push(node.arguments[0].text);
			}
		}

		if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			if (
				ts.isLiteralTypeNode(argument) &&
				ts.isStringLiteral(argument.literal)
			) {
				specifiers.push(argument.literal.text);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return specifiers;
}

const packageRoots = existsSync(packagesDir)
	? readdirSync(packagesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(packagesDir, entry.name))
			.filter((dir) => existsSync(join(dir, "package.json")))
	: [];

const errors = [];

for (const packageRoot of packageRoots) {
	const srcRoot = join(packageRoot, "src");
	const files = walk(srcRoot);
	for (const filePath of files) {
		const specifiers = collectSpecifiers(
			filePath,
			readFileSync(filePath, "utf8"),
		);
		for (const specifier of specifiers) {
			if (specifier.startsWith(".")) {
				const resolved = resolveImportPath(filePath, specifier);
				if (isSubpath(packageRoot, resolved)) {
					continue;
				}
				if (isAllowedOutside(filePath, resolved)) {
					continue;
				}
				errors.push(
					`${relative(repoRoot, filePath)} imports ${specifier} which resolves outside ${relative(
						repoRoot,
						packageRoot,
					)}`,
				);
				continue;
			}

			if (/^@evalops\/.+\/(src|dist)(\/|$)/.test(specifier)) {
				errors.push(
					`${relative(repoRoot, filePath)} imports ${specifier}; use package entrypoints instead of /src or /dist`,
				);
			}
		}
	}
}

if (errors.length > 0) {
	console.error("Package boundary violations detected:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}
