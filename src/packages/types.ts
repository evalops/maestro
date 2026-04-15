/**
 * Maestro Package System Types
 *
 * Defines types for distributable extension bundles that can be loaded
 * from local filesystem, git repositories, or npm packages.
 */

/**
 * Package manifest (maestro section in package.json)
 */
export interface MaestroManifest {
	/** Paths to extension directories */
	extensions?: string[];
	/** Paths to skill directories */
	skills?: string[];
	/** Paths to prompt template directories */
	prompts?: string[];
	/** Paths to theme directories */
	themes?: string[];
}

/**
 * Package.json structure for maestro packages
 */
export interface PackageJson {
	name: string;
	version?: string;
	keywords?: string[];
	maestro?: MaestroManifest;
}

/**
 * Package source types
 */
export type PackageSourceType = "local" | "git" | "npm";

/**
 * Git source with optional reference
 */
export interface GitSource {
	type: "git";
	url: string;
	ref?: string; // branch, tag, or commit
}

/**
 * Local filesystem source
 */
export interface LocalSource {
	type: "local";
	path: string;
}

/**
 * npm registry source
 */
export interface NpmSource {
	type: "npm";
	name: string;
	version?: string;
}

/**
 * Union of all source types
 */
export type PackageSource = GitSource | LocalSource | NpmSource;

/**
 * Resource filter patterns
 */
export interface ResourceFilters {
	/** Glob patterns for extensions (supports ! for exclusion) */
	extensions?: string[];
	/** Glob patterns for skills */
	skills?: string[];
	/** Glob patterns for prompts */
	prompts?: string[];
	/** Glob patterns for themes */
	themes?: string[];
}

/**
 * Package specification - string or object form
 */
export type PackageSpec =
	| string // "local:./path" or "git:url" or "npm:name@version"
	| (ResourceFilters & { source: string });

/**
 * Loaded package metadata
 */
export interface LoadedPackage {
	/** Package name from package.json */
	name: string;
	/** Package version */
	version?: string;
	/** Resolved source information */
	source: PackageSource;
	/** Absolute path to package directory */
	path: string;
	/** Package manifest */
	manifest: MaestroManifest;
	/** Applied filters */
	filters?: ResourceFilters;
}

/**
 * Loaded resources from a package
 */
export interface PackageResources {
	/** Package metadata */
	package: LoadedPackage;
	/** Loaded extension paths */
	extensions: string[];
	/** Loaded skill paths */
	skills: string[];
	/** Loaded prompt paths */
	prompts: string[];
	/** Loaded theme paths */
	themes: string[];
}

/**
 * Package discovery result
 */
export interface DiscoveredPackage {
	/** Package directory path */
	path: string;
	/** Parsed package.json */
	packageJson: PackageJson;
	/** Whether package has maestro-package keyword */
	isMaestroPackage: boolean;
	/** Validation errors if any */
	errors?: string[];
}

/**
 * Package loader options
 */
export interface PackageLoaderOptions {
	/** Working directory for resolving relative paths */
	cwd?: string;
	/** Whether to validate package contents */
	validate?: boolean;
	/** Custom cache directory for git/npm packages */
	cacheDir?: string;
}
