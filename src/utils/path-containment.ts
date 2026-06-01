import { isAbsolute, relative, resolve } from "node:path";

export function isPathWithin(child: string, parent: string): boolean {
	const normalizedChild = resolve(child);
	const normalizedParent = resolve(parent);
	if (normalizedChild === normalizedParent) {
		return true;
	}
	if (normalizedParent === "/") {
		return normalizedChild.startsWith("/");
	}
	const rel = relative(normalizedParent, normalizedChild);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
