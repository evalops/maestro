export {
	RotatingLogWriter,
	type LogRotationInfo,
	type RotatingLogWriterOptions,
} from "./log-rotation.js";
export {
	ResourceMonitor,
	extractProcStatFields,
	type TaskResourceUsage,
} from "./resource-monitor.js";
export {
	canRestart,
	computeRestartDelay,
	createRestartPolicy,
	incrementAttempts,
	shouldNotifyRestart,
	updateNotifyThreshold,
	type RestartPolicy,
	type RestartPolicyOptions,
} from "./restart-policy.js";
