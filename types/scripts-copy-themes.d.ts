declare module "../../scripts/copy-themes.js" {
	export interface CopyThemesOptions {
		sourceDir?: string;
		targetDir?: string;
	}

	export function copyThemes(options?: CopyThemesOptions): void;
}
