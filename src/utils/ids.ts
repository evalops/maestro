import { randomUUID } from "node:crypto";

export interface IdGenerator {
	uuid(): string;
}

export const systemIdGenerator: IdGenerator = {
	uuid: () => randomUUID(),
};
