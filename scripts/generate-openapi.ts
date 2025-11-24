import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

type Route = { method: string; path: string };

function extractRoutes(sourcePath: string): Route[] {
	const sourceText = readFileSync(sourcePath, "utf8");
	const sf = ts.createSourceFile(
		sourcePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const routes: Route[] = [];

	function visit(node: ts.Node) {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === "routes" &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const el of node.initializer.elements) {
				if (!ts.isObjectLiteralExpression(el)) continue;
				let method: string | undefined;
				let path: string | undefined;
				for (const prop of el.properties) {
					if (!ts.isPropertyAssignment(prop)) continue;
					const key = prop.name.getText().replace(/['"]/g, "");
					if (key === "method" && ts.isStringLiteral(prop.initializer)) {
						method = prop.initializer.text.toLowerCase();
					}
					if (key === "path" && ts.isStringLiteral(prop.initializer)) {
						path = prop.initializer.text;
					}
				}
				if (method && path) {
					routes.push({ method, path });
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return routes;
}

function buildSpec(routes: Route[]) {
	const paths: Record<string, any> = {};
	for (const { method, path } of routes) {
		const lower = method.toLowerCase();
		if (!paths[path]) paths[path] = {};
		paths[path][lower] = {
			summary: "Auto-generated from route definition",
			responses: { 200: { description: "OK" } },
		};
	}

	return {
		openapi: "3.1.0",
		info: {
			title: "Composer Web API",
			version: "0.10.0",
			description:
				"Auto-generated from src/web-server.ts routes. Extend components/schemas as needed.",
		},
		servers: [{ url: "http://localhost:8080" }],
		paths,
		components: {
			securitySchemes: {
				ComposerApiKey: {
					type: "apiKey",
					in: "header",
					name: "x-composer-api-key",
				},
			},
		},
	};
}

function main() {
	const routes = extractRoutes("src/web-server.ts");
	const spec = buildSpec(routes);
	writeFileSync("openapi.json", JSON.stringify(spec, null, 2), "utf8");
	console.log(`Generated openapi.json with ${routes.length} routes.`);
}

main();
