#!/usr/bin/env node
/**
 * Ratchet against module-scope `defaultRuntimeEnv()` snapshots.
 *
 * `defaultRuntimeEnv()` is a compatibility bridge while callers migrate to
 * injected `RuntimeEnv`. It must not be captured at import time: bootstrap may
 * still need to load dotenv files, scrub repo-controlled security overrides,
 * and reset the snapshot before application code observes it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcRoot = resolve(repoRoot, "src");

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const full = resolve(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (
			st.isFile() &&
			(name.endsWith(".ts") || name.endsWith(".tsx")) &&
			!name.endsWith(".d.ts")
		) {
			yield full;
		}
	}
}

function scriptKindFor(absPath) {
	return absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function compactText(text) {
	return text.replace(/\s+/g, " ").trim();
}

function classHeaderText(sourceFile, node) {
	const start = node.getStart(sourceFile);
	const bodyStart = node.members.pos;
	return compactText(sourceFile.text.slice(start, bodyStart));
}

function reportText(sourceFile, node) {
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		return classHeaderText(sourceFile, node);
	}
	return compactText(node.getText(sourceFile));
}

function addFinding(ctx, reportNode) {
	const start = reportNode.getStart(ctx.sourceFile);
	const key = `${ctx.rel}:${start}`;
	if (ctx.seen.has(key)) return;
	ctx.seen.add(key);

	const position = ctx.sourceFile.getLineAndCharacterOfPosition(start);
	ctx.findings.push({
		file: ctx.rel,
		line: position.line + 1,
		text: reportText(ctx.sourceFile, reportNode),
	});
}

function unwrapExpression(node) {
	let current = node;
	for (;;) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isTypeAssertionExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return current;
	}
}

function isDefaultRuntimeEnvCallee(node) {
	const callee = unwrapExpression(node);
	if (ts.isIdentifier(callee)) {
		return callee.text === "defaultRuntimeEnv";
	}
	if (
		(ts.isPropertyAccessExpression(callee) ||
			ts.isPropertyAccessChain(callee)) &&
		callee.name.text === "defaultRuntimeEnv"
	) {
		return true;
	}
	return false;
}

function isDefaultRuntimeEnvCall(node) {
	return ts.isCallExpression(node) && isDefaultRuntimeEnvCallee(node.expression);
}

function getIifeFunctionExpression(node) {
	if (!ts.isCallExpression(node)) return null;
	const callee = unwrapExpression(node.expression);
	if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
		return callee;
	}
	if (
		(ts.isPropertyAccessExpression(callee) ||
			ts.isPropertyAccessChain(callee)) &&
		(callee.name.text === "call" || callee.name.text === "apply")
	) {
		const receiver = unwrapExpression(callee.expression);
		if (ts.isFunctionExpression(receiver) || ts.isArrowFunction(receiver)) {
			return receiver;
		}
	}
	return null;
}

function isIifeCall(node) {
	return getIifeFunctionExpression(node) !== null;
}

function isLazyFunctionBoundary(node) {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

function hasStaticModifier(node) {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some(
			(modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
		)
	);
}

function scanDecorators(node, ctx, reportNode) {
	if (!ts.canHaveDecorators(node)) return;
	for (const decorator of ts.getDecorators(node) ?? []) {
		scanEager(decorator.expression, ctx, reportNode);
	}
}

function scanClass(node, ctx, reportNode, options = {}) {
	scanDecorators(node, ctx, reportNode);
	for (const clause of node.heritageClauses ?? []) {
		for (const typeNode of clause.types) {
			scanEager(typeNode.expression, ctx, reportNode);
		}
	}

	for (const member of node.members) {
		scanDecorators(member, ctx, member);

		if (member.name && ts.isComputedPropertyName(member.name)) {
			scanEager(member.name.expression, ctx, member);
		}

		if (ts.isClassStaticBlockDeclaration(member)) {
			scanEagerChildren(member, ctx, member);
			continue;
		}

		if (
			options.scanInstanceInitializers === true &&
			ts.isConstructorDeclaration(member)
		) {
			for (const parameter of member.parameters) {
				if (parameter.initializer) {
					scanEager(parameter.initializer, ctx, member);
				}
			}
			if (member.body) {
				scanEagerChildren(member.body, ctx, member);
			}
			continue;
		}

		if (
			(hasStaticModifier(member) || options.scanInstanceInitializers === true) &&
			ts.isPropertyDeclaration(member) &&
			member.initializer
		) {
			scanEager(member.initializer, ctx, member);
		}
	}
}

function scanEnum(node, ctx, reportNode) {
	for (const member of node.members) {
		if (member.initializer) {
			scanEager(member.initializer, ctx, reportNode);
		}
	}
}

function scanEagerFunctionBody(fn, ctx, reportNode) {
	for (const parameter of fn.parameters ?? []) {
		if (parameter.initializer) {
			scanEager(parameter.initializer, ctx, reportNode);
		}
	}

	const body = fn.body;
	if (ts.isBlock(body)) {
		scanEagerChildren(body, ctx, reportNode);
		return;
	}
	scanEager(body, ctx, reportNode);
}

function scanIifeFunctionBody(node, ctx, reportNode) {
	const callee = getIifeFunctionExpression(node);
	if (!callee) return;
	scanEagerFunctionBody(callee, ctx, reportNode);
}

function scanCall(node, ctx, reportNode) {
	if (isDefaultRuntimeEnvCall(node)) {
		addFinding(ctx, reportNode);
		return;
	}

	for (const argument of node.arguments) {
		scanEager(argument, ctx, reportNode);
	}

	if (isIifeCall(node)) {
		scanIifeFunctionBody(node, ctx, reportNode);
		return;
	}

	scanEager(node.expression, ctx, reportNode);
}

function scanNewExpression(node, ctx, reportNode) {
	for (const argument of node.arguments ?? []) {
		scanEager(argument, ctx, reportNode);
	}

	const expression = unwrapExpression(node.expression);
	if (ts.isClassExpression(expression)) {
		scanClass(expression, ctx, expression, {
			scanInstanceInitializers: true,
		});
		return;
	}
	if (ts.isFunctionExpression(expression)) {
		scanEagerFunctionBody(expression, ctx, expression);
		return;
	}

	scanEager(expression, ctx, reportNode);
}

function scanEagerChildren(node, ctx, reportNode) {
	ts.forEachChild(node, (child) => {
		scanEager(child, ctx, reportNode);
	});
}

function scanEager(node, ctx, reportNode) {
	if (isDefaultRuntimeEnvCall(node)) {
		addFinding(ctx, reportNode);
		return;
	}

	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		scanClass(node, ctx, node);
		return;
	}

	if (ts.isEnumDeclaration(node)) {
		scanEnum(node, ctx, node);
		return;
	}

	if (ts.isCallExpression(node)) {
		scanCall(node, ctx, reportNode);
		return;
	}

	if (ts.isNewExpression(node)) {
		scanNewExpression(node, ctx, reportNode);
		return;
	}

	if (isLazyFunctionBoundary(node)) {
		return;
	}

	scanEagerChildren(node, ctx, reportNode);
}

function scanSourceFile(absPath) {
	const rel = relative(repoRoot, absPath);
	const sourceText = readFileSync(absPath, "utf-8");
	const sourceFile = ts.createSourceFile(
		absPath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(absPath),
	);
	const ctx = {
		findings: [],
		rel,
		seen: new Set(),
		sourceFile,
	};

	for (const statement of sourceFile.statements) {
		scanEager(statement, ctx, statement);
	}
	return ctx.findings;
}

export function scanRuntimeEnvSnapshotHygiene(root = srcRoot) {
	const findings = [];
	for (const absPath of walk(root)) {
		findings.push(...scanSourceFile(absPath));
	}
	return findings;
}

function main() {
	const findings = scanRuntimeEnvSnapshotHygiene();
	if (findings.length === 0) {
		console.log("✓ No module-scope defaultRuntimeEnv() snapshots in src/");
		return;
	}

	console.error(
		"\n✗ Module-scope defaultRuntimeEnv() snapshots detected in src/.\n",
	);
	console.error(
		"Move the read behind an explicit bootstrap boundary or inject RuntimeEnv from the caller:\n",
	);
	for (const finding of findings) {
		console.error(`  ${finding.file}:${finding.line}`);
		console.error(`    ${finding.text}`);
	}
	console.error("");
	process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
