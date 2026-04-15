import { describe, expect, it } from "vitest";
import { getNextPageFromLink, parseLinkHeader } from "./pagination.js";

describe("pagination", () => {
	it("parses link headers into rel map", () => {
		const header =
			'<https://api.github.com/resource?page=2>; rel="next", <https://api.github.com/resource?page=5>; rel="last"';
		const links = parseLinkHeader(header);
		expect(links.next).toBe("https://api.github.com/resource?page=2");
		expect(links.last).toBe("https://api.github.com/resource?page=5");
	});

	it("extracts next page number", () => {
		const header =
			'<https://api.github.com/resource?page=3&per_page=100>; rel="next"';
		expect(getNextPageFromLink(header)).toBe(3);
	});

	it("returns null when next rel missing", () => {
		const header =
			'<https://api.github.com/resource?page=1>; rel="prev", <https://api.github.com/resource?page=10>; rel="last"';
		expect(getNextPageFromLink(header)).toBeNull();
	});
});
