export type LinkMap = Record<string, string>;

export function parseLinkHeader(header?: string | null): LinkMap {
	if (!header) return {};
	const links: LinkMap = {};
	for (const part of header.split(",")) {
		const section = part.trim();
		if (!section) continue;
		const match = section.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
		if (!match) continue;
		const [, url, rel] = match;
		if (url && rel) {
			links[rel] = url;
		}
	}
	return links;
}

export function getNextPageFromLink(header?: string | null): number | null {
	const links = parseLinkHeader(header);
	const next = links.next;
	if (!next) return null;
	try {
		const url = new URL(next, "https://api.github.com");
		const page = url.searchParams.get("page");
		if (!page) return null;
		const parsed = Number.parseInt(page, 10);
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}
