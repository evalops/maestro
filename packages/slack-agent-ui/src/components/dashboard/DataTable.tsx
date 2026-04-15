/** Dashboard data table with sortable columns and search. */

import { useMemo, useState } from "react";
import type { TableComponent } from "../../types/dashboard";

export function DataTable({ title, columns, rows }: TableComponent) {
	const [sortKey, setSortKey] = useState<string | null>(null);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
	const [search, setSearch] = useState("");

	const filteredRows = useMemo(() => {
		if (!search.trim()) return rows;
		const q = search.toLowerCase();
		return rows.filter((row) =>
			columns.some((col) =>
				String(row[col.key] ?? "")
					.toLowerCase()
					.includes(q),
			),
		);
	}, [rows, columns, search]);

	const sortedRows = useMemo(() => {
		if (!sortKey) return filteredRows;
		return [...filteredRows].sort((a, b) => {
			const av = String(a[sortKey] ?? "");
			const bv = String(b[sortKey] ?? "");
			const numA = Number(av.replace(/[^0-9.\-]/g, ""));
			const numB = Number(bv.replace(/[^0-9.\-]/g, ""));
			const cmp =
				!Number.isNaN(numA) && !Number.isNaN(numB)
					? numA - numB
					: av.localeCompare(bv);
			return sortDir === "asc" ? cmp : -cmp;
		});
	}, [filteredRows, sortKey, sortDir]);

	const handleSort = (key: string) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			setSortDir("asc");
		}
	};

	return (
		<div className="dashboard-table-wrapper">
			{(title || rows.length > 5) && (
				<div className="dashboard-table-header">
					{title && <div className="dashboard-chart-title">{title}</div>}
					{rows.length > 5 && (
						<input
							type="text"
							className="dashboard-table-search"
							placeholder="Search..."
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					)}
				</div>
			)}
			<table className="dashboard-table">
				<thead>
					<tr>
						{columns.map((col) => (
							<th
								key={col.key}
								style={{ textAlign: col.align ?? "left" }}
								className={
									col.sortable !== false ? "dashboard-table-sortable" : ""
								}
								onClick={() => col.sortable !== false && handleSort(col.key)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										if (col.sortable !== false) handleSort(col.key);
									}
								}}
							>
								{col.label}
								{sortKey === col.key && (
									<span className="dashboard-table-sort-icon">
										{sortDir === "asc" ? " \u25B2" : " \u25BC"}
									</span>
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{sortedRows.map((row, i) => (
						<tr
							// biome-ignore lint/suspicious/noArrayIndexKey: table rows lack natural keys
							key={i}
						>
							{columns.map((col) => (
								<td key={col.key} style={{ textAlign: col.align ?? "left" }}>
									{String(row[col.key] ?? "")}
								</td>
							))}
						</tr>
					))}
					{sortedRows.length === 0 && (
						<tr>
							<td
								colSpan={columns.length}
								style={{
									textAlign: "center",
									color: "var(--text-muted)",
									padding: 24,
								}}
							>
								{search ? "No matching rows" : "No data"}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
