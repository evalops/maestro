import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const todoDir = mkdtempSync(join(tmpdir(), "composer-todos-"));
const todoFile = join(todoDir, "todos.json");

process.env.MAESTRO_TODO_FILE = todoFile;

afterAll(() => {
	rmSync(todoDir, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "MAESTRO_TODO_FILE");
});
