export function webSessionEventEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...env,
		MAESTRO_EVENT_BUS_SOURCE: env.MAESTRO_EVENT_BUS_SOURCE ?? "maestro.web",
		MAESTRO_SURFACE: env.MAESTRO_SURFACE ?? "web",
	};
}
