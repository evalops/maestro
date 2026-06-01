import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirs = new Set(["dist", "node_modules", ".external"]);

function isSubpath(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function withTrailingSep(path) {
	return path.endsWith(sep) ? path : path + sep;
}

function isAllowedOutside(filePath, resolvedPath, allowedOutside) {
	return allowedOutside.some((rule) => {
		if (!filePath.startsWith(rule.filePrefix)) {
			return false;
		}
		return rule.allowedPrefixes.some((prefix) => resolvedPath.startsWith(prefix));
	});
}

function packageOwnedRuleForFile(filePath, packageOwned) {
	return packageOwned.find((rule) => filePath.startsWith(rule.filePrefix));
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

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageBoundaryConfig(packageJson) {
	const config = packageJson.maestro?.packageBoundary;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return undefined;
	}
	return config;
}

function boundaryRulesForPackage(repoRoot, packageRoot, packageJson, errors) {
	const config = packageBoundaryConfig(packageJson);
	if (!config) {
		return [];
	}
	const packageName =
		typeof packageJson.name === "string"
			? packageJson.name
			: relative(repoRoot, packageRoot);
	if (config.mode !== "internal-facade") {
		errors.push(
			`${relative(
				repoRoot,
				packageRoot,
			)} has unsupported maestro.packageBoundary.mode ${JSON.stringify(
				config.mode,
			)}`,
		);
		return [];
	}
	if (typeof config.rationale !== "string" || config.rationale.trim() === "") {
		errors.push(
			`${packageName} declares an internal facade boundary without a rationale`,
		);
	}
	if (!Array.isArray(config.allowedExternalSourceRoots)) {
		errors.push(
			`${packageName} declares an internal facade boundary without allowedExternalSourceRoots`,
		);
		return [];
	}

	const allowedPrefixes = [];
	for (const root of config.allowedExternalSourceRoots) {
		if (typeof root !== "string" || root.trim() === "") {
			errors.push(
				`${packageName} has an invalid allowedExternalSourceRoots entry`,
			);
			continue;
		}
		const resolved = resolve(packageRoot, root);
		if (!isSubpath(repoRoot, resolved)) {
			errors.push(
				`${packageName} allows source root ${root} outside the repository`,
			);
			continue;
		}
		if (isSubpath(packageRoot, resolved)) {
			errors.push(
				`${packageName} allows source root ${root} inside its own package; remove the facade exception`,
			);
			continue;
		}
		allowedPrefixes.push(withTrailingSep(resolved));
	}

	if (allowedPrefixes.length === 0) {
		return [];
	}
	return [
		{
			filePrefix: withTrailingSep(join(packageRoot, "src")),
			allowedPrefixes,
		},
	];
}

function packageOwnedRulesForPackage(repoRoot, packageRoot, packageJson, errors) {
	const config = packageBoundaryConfig(packageJson);
	if (!config?.packageOwnedSourceRoots) {
		return [];
	}
	const packageName =
		typeof packageJson.name === "string"
			? packageJson.name
			: relative(repoRoot, packageRoot);
	if (!Array.isArray(config.packageOwnedSourceRoots)) {
		errors.push(
			`${packageName} declares packageOwnedSourceRoots but it is not an array`,
		);
		return [];
	}
	const rules = [];
	for (const root of config.packageOwnedSourceRoots) {
		if (typeof root !== "string" || root.trim() === "") {
			errors.push(`${packageName} has an invalid packageOwnedSourceRoots entry`);
			continue;
		}
		const resolved = resolve(packageRoot, root);
		if (!isSubpath(packageRoot, resolved)) {
			errors.push(
				`${packageName} package-owned source root ${root} must stay inside the package`,
			);
			continue;
		}
		rules.push({
			filePrefix: withTrailingSep(resolved),
			packageRoot,
			label: `${relative(repoRoot, packageRoot)}:${root}`,
		});
	}
	return rules;
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

export function validatePackageBoundaries(root = repoRoot) {
	const packagesDir = join(root, "packages");
	const packageRoots = existsSync(packagesDir)
		? readdirSync(packagesDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(packagesDir, entry.name))
				.filter((dir) => existsSync(join(dir, "package.json")))
		: [];

	const errors = [];
	const packageJsonByRoot = new Map(
		packageRoots.map((packageRoot) => [
			packageRoot,
			readJson(join(packageRoot, "package.json")),
		]),
	);
	const allowedOutside = [];
	const packageOwned = [];
	for (const [packageRoot, packageJson] of packageJsonByRoot) {
		allowedOutside.push(
			...boundaryRulesForPackage(root, packageRoot, packageJson, errors),
		);
		packageOwned.push(
			...packageOwnedRulesForPackage(root, packageRoot, packageJson, errors),
		);
	}

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
					const ownedRule = packageOwnedRuleForFile(filePath, packageOwned);
					if (ownedRule) {
						errors.push(
							`${relative(root, filePath)} imports ${specifier} which resolves outside package-owned root ${ownedRule.label}`,
						);
						continue;
					}
					if (isAllowedOutside(filePath, resolved, allowedOutside)) {
						continue;
					}
					errors.push(
						`${relative(root, filePath)} imports ${specifier} which resolves outside ${relative(
							root,
							packageRoot,
						)}`,
					);
					continue;
				}

				if (/^@evalops\/.+\/(src|dist)(\/|$)/.test(specifier)) {
					errors.push(
						`${relative(root, filePath)} imports ${specifier}; use package entrypoints instead of /src or /dist`,
					);
				}
			}
		}
	}

	return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const errors = validatePackageBoundaries();
	if (errors.length > 0) {
		console.error("Package boundary violations detected:");
		for (const error of errors) {
			console.error(`- ${error}`);
		}
		process.exit(1);
	}
}
