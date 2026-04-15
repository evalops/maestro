import type { AgentTool } from "../agent/types.js";
import { askUserSchema } from "./ask-user.js";

export const askUserClientTool: AgentTool<typeof askUserSchema> = {
	name: "ask_user",
	label: "ask",
	description:
		"Ask the attached client for structured user input with predefined options.",
	parameters: askUserSchema,
	executionLocation: "client",
	execute: async () => {
		throw new Error("ask_user must be executed by the connected client");
	},
};
