(() => {
	try {
		const stored = localStorage.getItem("composer_theme");
		const prefersLight = window.matchMedia?.(
			"(prefers-color-scheme: light)",
		).matches;
		const theme =
			stored === "light" || stored === "dark"
				? stored
				: prefersLight
					? "light"
					: "dark";
		document.documentElement.dataset.theme = theme;
	} catch (_error) {
		document.documentElement.dataset.theme = "dark";
	}
})();
