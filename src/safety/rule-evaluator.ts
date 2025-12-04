/**
 * Rule Evaluator
 *
 * Lightweight, composable rule evaluation scaffold for safety policies.
 * This is a starting point for issue #292; current codebase is unaffected
 * until callers adopt these helpers.
 */

export interface RuleResult {
	allowed: boolean;
	reason?: string;
}

export interface Rule<TContext> {
	name: string;
	evaluate(context: TContext): RuleResult;
}

/**
 * Evaluate rules in order, returning the first denial or the last allow.
 * If no rules are provided, defaults to allow.
 */
export function evaluateRules<TContext>(
	rules: Rule<TContext>[],
	context: TContext,
): RuleResult {
	let lastAllow: RuleResult = { allowed: true };

	for (const rule of rules) {
		const result = rule.evaluate(context);
		if (!result.allowed) {
			return {
				...result,
				reason: result.reason ?? `Rule "${rule.name}" denied`,
			};
		}
		lastAllow = result;
	}

	return lastAllow;
}
