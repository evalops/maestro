/**
 * Enterprise Context
 * Centralized user/org context for audit logging, policy checks, and billing
 *
 * This module uses AsyncLocalStorage to provide request-scoped context isolation.
 * This prevents session/metadata leakage between concurrent web server requests.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("enterprise:context");

export interface EnterpriseUser {
	userId: string;
	orgId: string;
	email?: string;
	roles?: string[];
}

export interface EnterpriseSession {
	sessionId: string;
	startedAt: Date;
	modelId?: string;
}

export interface EnterpriseContextData {
	user: EnterpriseUser | null;
	session: EnterpriseSession | null;
	requestId?: string;
	traceId?: string;
	ipAddress?: string;
	userAgent?: string;
}

type ContextEventMap = {
	userChanged: [user: EnterpriseUser | null];
	sessionStarted: [session: EnterpriseSession];
	sessionEnded: [sessionId: string];
	toolExecuted: [toolName: string, status: "success" | "failure" | "denied"];
};

/**
 * AsyncLocalStorage for request-scoped context.
 * This ensures each concurrent request has isolated session/metadata.
 */
const requestScopedContext = new AsyncLocalStorage<EnterpriseContextData>();

class EnterpriseContextManager extends EventEmitter<ContextEventMap> {
	private globalContext: EnterpriseContextData = {
		user: null,
		session: null,
	};

	private initialized = false;

	/**
	 * Get the current context (request-scoped if available, otherwise global).
	 * This allows both CLI (global) and web server (request-scoped) usage.
	 */
	private get context(): EnterpriseContextData {
		return requestScopedContext.getStore() ?? this.globalContext;
	}

	/**
	 * Initialize enterprise context from environment/token
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			const token = process.env.MAESTRO_ENTERPRISE_TOKEN;
			if (token) {
				const { verifyToken } = await import("../auth/jwt.js");
				const payload = verifyToken(token);
				if (payload) {
					this.context.user = {
						userId: payload.userId,
						orgId: payload.orgId,
						email: payload.email,
						roles: payload.roleId ? [payload.roleId] : undefined,
					};
					logger.debug("Enterprise context initialized", {
						userId: payload.userId,
						orgId: payload.orgId,
					});
				}
			}
		} catch (error) {
			logger.debug("Enterprise context not available", {
				reason: error instanceof Error ? error.message : "Unknown",
			});
		}

		this.initialized = true;
	}

	/**
	 * Set the current user context
	 */
	setUser(user: EnterpriseUser | null): void {
		this.context.user = user;
		this.emit("userChanged", user);
	}

	/**
	 * Get the current user context
	 */
	getUser(): EnterpriseUser | null {
		return this.context.user;
	}

	/**
	 * Check if enterprise features are available
	 */
	isEnterprise(): boolean {
		return this.context.user !== null;
	}

	/**
	 * Start a new session
	 */
	startSession(sessionId: string, modelId?: string): void {
		this.context.session = {
			sessionId,
			startedAt: new Date(),
			modelId,
		};
		this.emit("sessionStarted", this.context.session);
	}

	/**
	 * End the current session
	 */
	endSession(): void {
		if (this.context.session) {
			const sessionId = this.context.session.sessionId;
			this.context.session = null;
			this.emit("sessionEnded", sessionId);
		}
	}

	/**
	 * Get the current session
	 */
	getSession(): EnterpriseSession | null {
		return this.context.session;
	}

	/**
	 * Set request metadata for tracing
	 */
	setRequestMetadata(metadata: {
		requestId?: string;
		traceId?: string;
		ipAddress?: string;
		userAgent?: string;
	}): void {
		Object.assign(this.context, metadata);
	}

	/**
	 * Get the full context for audit logging
	 */
	getAuditContext(): {
		orgId: string;
		userId: string;
		sessionId?: string;
		requestId?: string;
		traceId?: string;
		ipAddress?: string;
		userAgent?: string;
	} | null {
		if (!this.context.user) return null;

		return {
			orgId: this.context.user.orgId,
			userId: this.context.user.userId,
			sessionId: this.context.session?.sessionId,
			requestId: this.context.requestId,
			traceId: this.context.traceId,
			ipAddress: this.context.ipAddress,
			userAgent: this.context.userAgent,
		};
	}

	/**
	 * Record a tool execution event
	 */
	recordToolExecution(
		toolName: string,
		status: "success" | "failure" | "denied",
	): void {
		this.emit("toolExecuted", toolName, status);
	}

	/**
	 * Reset the global context (for testing)
	 */
	reset(): void {
		this.globalContext = {
			user: null,
			session: null,
		};
		this.initialized = false;
	}

	/**
	 * Run a callback with an isolated request-scoped context.
	 * Use this for web server requests to prevent context leakage.
	 *
	 * @param callback - The function to run within the isolated context
	 * @param initialContext - Optional initial context data
	 * @returns The return value of the callback
	 */
	runWithContext<T>(
		callback: () => T,
		initialContext?: Partial<EnterpriseContextData>,
	): T {
		const scopedContext: EnterpriseContextData = {
			user: initialContext?.user ?? this.globalContext.user,
			session: initialContext?.session ?? null,
			requestId: initialContext?.requestId,
			traceId: initialContext?.traceId,
			ipAddress: initialContext?.ipAddress,
			userAgent: initialContext?.userAgent,
		};
		return requestScopedContext.run(scopedContext, callback);
	}

	/**
	 * Run an async callback with an isolated request-scoped context.
	 * Use this for web server requests to prevent context leakage.
	 *
	 * @param callback - The async function to run within the isolated context
	 * @param initialContext - Optional initial context data
	 * @returns A promise that resolves to the return value of the callback
	 */
	async runWithContextAsync<T>(
		callback: () => Promise<T>,
		initialContext?: Partial<EnterpriseContextData>,
	): Promise<T> {
		const scopedContext: EnterpriseContextData = {
			user: initialContext?.user ?? this.globalContext.user,
			session: initialContext?.session ?? null,
			requestId: initialContext?.requestId,
			traceId: initialContext?.traceId,
			ipAddress: initialContext?.ipAddress,
			userAgent: initialContext?.userAgent,
		};
		return requestScopedContext.run(scopedContext, callback);
	}
}

// Singleton instance
export const enterpriseContext = new EnterpriseContextManager();

// Convenience exports
export const getEnterpriseUser = () => enterpriseContext.getUser();
export const getEnterpriseSession = () => enterpriseContext.getSession();
export const isEnterprise = () => enterpriseContext.isEnterprise();
export const getAuditContext = () => enterpriseContext.getAuditContext();
