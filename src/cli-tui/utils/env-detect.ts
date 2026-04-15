import { existsSync, readFileSync, readdirSync } from "node:fs";

export function isDockerEnv(): boolean {
	if (process.env.DOCKER_CONTAINER === "1") return true;
	if (existsSync("/.dockerenv")) return true;
	const cgroupPath = "/proc/1/cgroup";
	if (existsSync(cgroupPath)) {
		try {
			const contents = readFileSync(cgroupPath, "utf8");
			if (contents.includes("docker") || contents.includes("kubepods")) {
				return true;
			}
		} catch {
			// ignore
		}
	}
	return false;
}

export function isWslEnv(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	const versionPath = "/proc/version";
	if (existsSync(versionPath)) {
		try {
			const contents = readFileSync(versionPath, "utf8").toLowerCase();
			if (contents.includes("microsoft")) {
				return true;
			}
		} catch {
			// ignore
		}
	}
	return false;
}

export function isJetBrainsTerminal(): boolean {
	const term = process.env.TERMINAL_EMULATOR ?? "";
	if (term.toLowerCase().includes("jediterm")) return true;
	if (process.env.JEDITERM_LOG_DIR) return true;
	return false;
}

export function isPodmanEnv(): boolean {
	if (process.env.CONTAINER_RUNTIME?.toLowerCase() === "podman") return true;
	if (process.env.CONTAINER?.toLowerCase() === "podman") return true;
	if (existsSync("/.containerenv")) return true;
	const cgroupPath = "/proc/1/cgroup";
	if (existsSync(cgroupPath)) {
		try {
			const contents = readFileSync(cgroupPath, "utf8");
			if (contents.includes("libpod")) {
				return true;
			}
		} catch {
			// ignore
		}
	}
	return false;
}

export function isSshEnv(): boolean {
	return Boolean(
		process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT,
	);
}

export function isTmuxEnv(): boolean {
	return Boolean(process.env.TMUX);
}

export function isScreenEnv(): boolean {
	return Boolean(process.env.STY);
}

export function isFlatpakEnv(): boolean {
	if (process.env.FLATPAK_ID || process.env.FLATPAK_SANDBOX_DIR) return true;
	return existsSync("/.flatpak-info");
}

export function isBubblewrapEnv(): boolean {
	const args = process.env.BWRAP_ARGS;
	if (!args) return false;
	return args.trim().length > 0;
}

export function isMuslEnv(): boolean {
	if (process.platform !== "linux") return false;
	const report = process.report?.getReport?.() as
		| { header?: { glibcVersionRuntime?: string } }
		| undefined;
	const glibcVersion = report?.header?.glibcVersionRuntime;
	if (glibcVersion) return false;
	for (const dir of ["/lib", "/usr/lib", "/lib64", "/usr/lib64"]) {
		try {
			const entries = readdirSync(dir);
			if (entries.some((entry) => entry.startsWith("ld-musl-"))) {
				return true;
			}
		} catch {
			// ignore missing directories
		}
	}
	return false;
}
