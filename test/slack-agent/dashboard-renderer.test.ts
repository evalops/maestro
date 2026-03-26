/**
 * Tests for the dashboard renderer.
 */

import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	generateDashboardHtml,
} from "../../packages/slack-agent/src/dashboard/renderer.js";
import type { DashboardSpec } from "../../packages/slack-agent/src/dashboard/types.js";

describe("escapeHtml", () => {
	it("escapes HTML special characters", () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);
	});

	it("escapes ampersands and single quotes", () => {
		expect(escapeHtml("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
	});
});

describe("generateDashboardHtml", () => {
	const minimalSpec: DashboardSpec = {
		title: "Test Dashboard",
		components: [],
	};

	it("returns valid HTML document", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<html");
		expect(html).toContain("</html>");
		expect(html).toContain("<head>");
		expect(html).toContain("<body>");
	});

	it("includes the title", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("<title>Test Dashboard</title>");
		expect(html).toContain("Test Dashboard");
	});

	it("includes subtitle when provided", () => {
		const spec: DashboardSpec = {
			...minimalSpec,
			subtitle: "Quarter 4 Report",
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("Quarter 4 Report");
	});

	it("escapes title and subtitle to prevent XSS", () => {
		const spec: DashboardSpec = {
			title: '<img src=x onerror="alert(1)">',
			subtitle: '"><script>evil()</script>',
			components: [],
		};
		const html = generateDashboardHtml(spec);
		// Title in the <title> tag and <h1> should be escaped
		expect(html).toContain(
			"<title>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</title>",
		);
		// Subtitle in the rendered HTML should be escaped
		expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
	});

	it("embeds the spec as JSON", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain('id="dashboard-spec"');
		expect(html).toContain("application/json");
		expect(html).toContain('"title":"Test Dashboard"');
	});

	it("includes Chart.js CDN link", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("chart.umd.min.js");
		expect(html).toContain("cdnjs.cloudflare.com");
	});

	it("defaults to dark theme", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain('data-theme="dark"');
	});

	it("supports light theme", () => {
		const spec: DashboardSpec = {
			...minimalSpec,
			theme: "light",
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain('data-theme="light"');
	});

	it("includes dark and light theme CSS variables", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain('[data-theme="dark"]');
		expect(html).toContain('[data-theme="light"]');
	});

	it("includes theme toggle button", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("toggleTheme");
		expect(html).toContain("theme-toggle");
	});

	it("renders stat-group component", () => {
		const spec: DashboardSpec = {
			title: "Stats",
			components: [
				{
					type: "stat-group",
					items: [
						{
							label: "Revenue",
							value: "$50k",
							change: "+10%",
							trend: "up",
						},
						{ label: "Users", value: "1.2k" },
					],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("stat-group");
		expect(html).toContain("renderStatGroup");
	});

	it("renders bar-chart component", () => {
		const spec: DashboardSpec = {
			title: "Charts",
			components: [
				{
					type: "bar-chart",
					labels: ["A", "B", "C"],
					datasets: [{ label: "Set 1", data: [1, 2, 3] }],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("bar-chart");
		expect(html).toContain("renderChart");
	});

	it("renders line-chart component", () => {
		const spec: DashboardSpec = {
			title: "Lines",
			components: [
				{
					type: "line-chart",
					labels: ["Jan", "Feb"],
					datasets: [{ label: "MRR", data: [100, 200] }],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("line-chart");
	});

	it("renders area-chart component", () => {
		const spec: DashboardSpec = {
			title: "Areas",
			components: [
				{
					type: "area-chart",
					labels: ["Q1", "Q2"],
					datasets: [{ label: "Growth", data: [50, 75] }],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("area-chart");
	});

	it("renders pie-chart component", () => {
		const spec: DashboardSpec = {
			title: "Pie",
			components: [
				{
					type: "pie-chart",
					labels: ["A", "B"],
					data: [60, 40],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("pie-chart");
	});

	it("renders doughnut-chart component", () => {
		const spec: DashboardSpec = {
			title: "Doughnut",
			components: [
				{
					type: "doughnut-chart",
					labels: ["Active", "Inactive"],
					data: [80, 20],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("doughnut-chart");
	});

	it("renders table component", () => {
		const spec: DashboardSpec = {
			title: "Table",
			components: [
				{
					type: "table",
					columns: [
						{ key: "name", label: "Name" },
						{ key: "val", label: "Value", align: "right" },
					],
					rows: [{ name: "Test", val: "123" }],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("data-table");
		expect(html).toContain("renderTable");
	});

	it("renders activity-feed component", () => {
		const spec: DashboardSpec = {
			title: "Feed",
			components: [
				{
					type: "activity-feed",
					items: [
						{
							text: "Something happened",
							time: "5 min ago",
							color: "#22c55e",
						},
					],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("activity-feed");
		expect(html).toContain("renderActivityFeed");
	});

	it("includes chart fallback message in JS", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("Charts require internet access");
	});

	it("includes color palette", () => {
		const html = generateDashboardHtml(minimalSpec);
		expect(html).toContain("#6366f1");
		expect(html).toContain("#3b82f6");
		expect(html).toContain("#22c55e");
	});

	it("renders a full dashboard with multiple components", () => {
		const spec: DashboardSpec = {
			title: "Full Dashboard",
			subtitle: "Complete test",
			theme: "dark",
			generatedAt: "2025-01-15T12:00:00.000Z",
			components: [
				{
					type: "stat-group",
					items: [{ label: "MRR", value: "$48k", change: "+5%" }],
				},
				{
					type: "line-chart",
					labels: ["Jan", "Feb", "Mar"],
					datasets: [{ label: "Revenue", data: [40, 45, 48] }],
				},
				{
					type: "table",
					columns: [{ key: "item", label: "Item" }],
					rows: [{ item: "Widget" }],
				},
				{
					type: "activity-feed",
					items: [{ text: "Event 1", time: "now" }],
				},
			],
		};
		const html = generateDashboardHtml(spec);
		expect(html).toContain("Full Dashboard");
		expect(html).toContain("Complete test");
		expect(html).toContain("stat-group");
		expect(html).toContain("line-chart");
		expect(html).toContain("data-table");
		expect(html).toContain("activity-feed");
	});

	it("escapes closing script tags in embedded JSON", () => {
		const spec: DashboardSpec = {
			title: "Test</script><script>alert(1)</script>",
			components: [],
		};
		const html = generateDashboardHtml(spec);
		// The embedded JSON should not contain literal </script>
		const jsonMatch = html.match(
			/<script type="application\/json" id="dashboard-spec">([\s\S]*?)<\/script>/,
		);
		expect(jsonMatch).toBeTruthy();
		expect(jsonMatch![1]).not.toContain("</script>");
	});
});
