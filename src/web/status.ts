export enum Code {
	OK = 0,
	CANCELLED = 1,
	UNKNOWN = 2,
	INVALID_ARGUMENT = 3,
	DEADLINE_EXCEEDED = 4,
	NOT_FOUND = 5,
	ALREADY_EXISTS = 6,
	PERMISSION_DENIED = 7,
	RESOURCE_EXHAUSTED = 8,
	FAILED_PRECONDITION = 9,
	ABORTED = 10,
	OUT_OF_RANGE = 11,
	UNIMPLEMENTED = 12,
	INTERNAL = 13,
	UNAVAILABLE = 14,
	DATA_LOSS = 15,
	UNAUTHENTICATED = 16,
}

export interface StatusDetail {
	"@type": string;
	[key: string]: unknown;
}

export class Status {
	constructor(
		public code: Code,
		public message: string,
		public details: StatusDetail[] = [],
	) {}

	static OK(): Status {
		return new Status(Code.OK, "");
	}

	static fromError(error: unknown): Status {
		if (error instanceof StatusError) {
			return error.status;
		}
		if (error instanceof Error) {
			return new Status(Code.UNKNOWN, error.message);
		}
		return new Status(Code.UNKNOWN, String(error));
	}

	toHttpCode(): number {
		switch (this.code) {
			case Code.OK:
				return 200;
			case Code.CANCELLED:
				return 499; // Client Closed Request
			case Code.UNKNOWN:
				return 500;
			case Code.INVALID_ARGUMENT:
				return 400;
			case Code.DEADLINE_EXCEEDED:
				return 504;
			case Code.NOT_FOUND:
				return 404;
			case Code.ALREADY_EXISTS:
				return 409;
			case Code.PERMISSION_DENIED:
				return 403;
			case Code.RESOURCE_EXHAUSTED:
				return 429;
			case Code.FAILED_PRECONDITION:
				return 400;
			case Code.ABORTED:
				return 409;
			case Code.OUT_OF_RANGE:
				return 400;
			case Code.UNIMPLEMENTED:
				return 501;
			case Code.INTERNAL:
				return 500;
			case Code.UNAVAILABLE:
				return 503;
			case Code.DATA_LOSS:
				return 500;
			case Code.UNAUTHENTICATED:
				return 401;
			default:
				return 500;
		}
	}

	toJSON() {
		return {
			code: this.code,
			message: this.message,
			details: this.details.length > 0 ? this.details : undefined,
		};
	}
}

export class StatusError extends Error {
	constructor(public status: Status) {
		super(status.message);
		this.name = "StatusError";
	}
}
