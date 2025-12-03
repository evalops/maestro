import { existsSync, readFileSync } from "node:fs";

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
