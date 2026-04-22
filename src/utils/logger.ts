/**
 * Structured logging service for Composer CLI.
 * Replaces scattered console.log/error calls with centralized, level-based logging.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../config/constants.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
	[key: string]: unknown;
}

interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
	context?: LogContext;
	error?: {
		name: string;
		message: string;
		stack?: string;
	};
}

/**
 * Logger configuration
 */
interface LoggerConfig {
	/** Minimum log level to output (debug < info < warn < error) */
	minLevel: LogLevel;
	/** Whether to output JSON format (useful for log aggregation) */
	jsonFormat: boolean;
	/** Whether to include timestamps */
	timestamps: boolean;
	/** Custom output function (defaults to console) */
	output?: (entry: LogEntry) => void;
}

const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

class Logger {
	private config: LoggerConfig;

	constructor(config?: Partial<LoggerConfig>) {
		this.config = {
			minLevel: (process.env.MAESTRO_LOG_LEVEL as LogLevel) ?? "info",
			jsonFormat: process.env.MAESTRO_LOG_JSON === "1",
			timestamps: true,
			...config,
		};
	}

	/**
	 * Check if a log level should be output
	 */
	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this.config.minLevel];
	}

	/**
	 * Format and output a log entry
	 */
	private log(
		level: LogLevel,
		message: string,
		context?: LogContext,
		error?: Error,
	): void {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			level,
			message,
			timestamp: new Date().toISOString(),
			context,
			error: error
				? {
						name: error.name,
						message: error.message,
						stack: error.stack,
					}
				: undefined,
		};

		if (this.config.output) {
			this.config.output(entry);
			return;
		}

		if (this.config.jsonFormat) {
			this.outputJson(entry);
		} else {
			this.outputPretty(entry);
		}
	}

	/**
	 * Output as JSON (for log aggregation systems)
	 */
	private outputJson(entry: LogEntry): void {
		const output = entry.level === "error" ? console.error : console.log;
		output(JSON.stringify(entry));
	}

	/**
	 * Output as human-readable format
	 */
	private outputPretty(entry: LogEntry): void {
		const output = entry.level === "error" ? console.error : console.log;
		const parts: string[] = [];

		if (this.config.timestamps) {
			parts.push(`[${entry.timestamp}]`);
		}

		parts.push(`[${entry.level.toUpperCase()}]`);
		parts.push(entry.message);

		if (entry.context && Object.keys(entry.context).length > 0) {
			parts.push(JSON.stringify(entry.context));
		}

		output(parts.join(" "));

		if (entry.error?.stack) {
			output(entry.error.stack);
		}
	}

	/**
	 * Log debug message (verbose, typically for development)
	 */
	debug(message: string, context?: LogContext): void {
		this.log("debug", message, context);
	}

	/**
	 * Log info message (general information)
	 */
	info(message: string, context?: LogContext): void {
		this.log("info", message, context);
	}

	/**
	 * Log warning message (potentially problematic situations)
	 */
	warn(message: string, context?: LogContext): void {
		this.log("warn", message, context);
	}

	/**
	 * Log error message (failures and exceptions)
	 */
	error(message: string, error?: Error, context?: LogContext): void {
		this.log("error", message, context, error);
	}

	/**
	 * Create a child logger with additional context
	 */
	child(additionalContext: LogContext): Logger {
		return new ContextualLogger(this, additionalContext);
	}

	/**
	 * Update logger configuration
	 */
	configure(config: Partial<LoggerConfig>): void {
		this.config = { ...this.config, ...config };
	}
}

/**
 * Logger that automatically includes context in all log calls
 */
class ContextualLogger extends Logger {
	constructor(
		private parent: Logger,
		private contextData: LogContext,
	) {
		super();
	}

	private mergeContext(context?: LogContext): LogContext {
		return { ...this.contextData, ...context };
	}

	override debug(message: string, context?: LogContext): void {
		this.parent.debug(message, this.mergeContext(context));
	}

	override info(message: string, context?: LogContext): void {
		this.parent.info(message, this.mergeContext(context));
	}

	override warn(message: string, context?: LogContext): void {
		this.parent.warn(message, this.mergeContext(context));
	}

	override error(message: string, error?: Error, context?: LogContext): void {
		this.parent.error(message, error, this.mergeContext(context));
	}
}

/**
 * Global logger instance
 */
export const logger = new Logger();

/**
 * Create a logger for a specific module/component
 */
export function createLogger(moduleName: string): Logger {
	return logger.child({ module: moduleName });
}

/**
 * Silence the logger (useful for TUI mode where stdout must not be polluted)
 */
export function silenceLogger(): void {
	logger.configure({ output: () => {} });
}

/**
 * Redirect all logs to a file (useful for TUI mode)
 * @param filePath - Path to the log file (defaults to ~/.maestro/logs/maestro.log)
 */
export function redirectLoggerToFile(filePath?: string): void {
	const logFile = filePath ?? join(PATHS.MAESTRO_HOME, "logs", "maestro.log");

	// Ensure directory exists
	try {
		mkdirSync(dirname(logFile), { recursive: true });
	} catch {
		// Directory may already exist
	}

	logger.configure({
		output: (entry) => {
			const parts: string[] = [];
			parts.push(`[${entry.timestamp}]`);
			parts.push(`[${entry.level.toUpperCase()}]`);
			parts.push(entry.message);

			if (entry.context && Object.keys(entry.context).length > 0) {
				parts.push(JSON.stringify(entry.context));
			}

			let line = `${parts.join(" ")}\n`;

			if (entry.error?.stack) {
				line += `${entry.error.stack}\n`;
			}

			try {
				appendFileSync(logFile, line);
			} catch {
				// Silently fail if we can't write to the log file
			}
		},
	});
}

/**
 * Redirect global console methods to the structured logger.
 *
 * Important: Call this only after redirectLoggerToFile() (or a custom logger
 * output) has been configured; otherwise console.* would route back to the
 * console-backed logger output and recurse.
 */
export function redirectConsoleToLogger(options?: {
	preserveErrorStderr?: boolean;
}): void {
	console.log = (...args: unknown[]) => {
		logger.info(args.map(String).join(" "));
	};
	console.info = (...args: unknown[]) => {
		logger.info(args.map(String).join(" "));
	};
	console.warn = (...args: unknown[]) => {
		logger.warn(args.map(String).join(" "));
	};
	console.error = (...args: unknown[]) => {
		if (options?.preserveErrorStderr) {
			originalConsole.error(...args);
			return;
		}
		// Preserve first Error stack if present
		const maybeError = args.find((a) => a instanceof Error) as
			| Error
			| undefined;
		if (maybeError) {
			logger.error(maybeError.message, maybeError);
		} else {
			logger.error(args.map(String).join(" "));
		}
	};
	console.debug = (...args: unknown[]) => {
		logger.debug(args.map(String).join(" "));
	};
}

/**
 * Redirect process.stderr writes to the structured logger.
 * Useful in TUI mode to prevent third-party libraries from corrupting the terminal.
 */
export function redirectStderrToLogger(): void {
	process.stderr.write = (chunk: unknown) => {
		const text =
			typeof chunk === "string"
				? chunk
				: chunk instanceof Buffer
					? chunk.toString()
					: String(chunk);
		logger.error(text.trimEnd());
		return true;
	};
}

/**
 * Wire process warning / rejection hooks into the logger so they don't hit stderr.
 */
export function pipeProcessEventsToLogger(): void {
	process.on("warning", (warning) => {
		logger.warn(
			`${warning.name}: ${warning.message}${
				warning.stack ? `\n${warning.stack}` : ""
			}`,
		);
	});

	process.on("unhandledRejection", (reason, promise) => {
		logger.error(
			`UnhandledRejection: ${String(reason)} (promise: ${String(promise)})`,
		);
	});

	process.on("uncaughtException", (error) => {
		if (error instanceof Error) {
			logger.error(error.message, error);
		} else {
			logger.error(`UncaughtException: ${String(error)}`);
		}
	});
}
