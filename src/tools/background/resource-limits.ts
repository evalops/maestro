import type { TaskResourceUsage } from "./index.js";
import type { ResourceLimitBreach, TaskRuntimeLimits } from "./task-types.js";

export function evaluateResourceLimitBreach(
	usage: TaskResourceUsage | undefined,
	limits: Pick<TaskRuntimeLimits, "maxRssKb" | "maxCpuMs">,
): ResourceLimitBreach | null {
	if (!usage) {
		return null;
	}

	const rssLimit = limits.maxRssKb ?? 0;
	const cpuLimit = limits.maxCpuMs ?? 0;

	if (rssLimit > 0 && (usage.maxRssKb ?? 0) > rssLimit) {
		return {
			kind: "memory",
			limit: rssLimit,
			actual: usage.maxRssKb ?? 0,
		};
	}

	const totalCpu = (usage.userMs ?? 0) + (usage.systemMs ?? 0);
	if (cpuLimit > 0 && totalCpu > cpuLimit) {
		return {
			kind: "cpu",
			limit: cpuLimit,
			actual: totalCpu,
		};
	}

	return null;
}
