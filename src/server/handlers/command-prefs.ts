import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { PATHS } from "../../config/constants.js";
import type { WebServerContext } from "../app-context.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

type CommandPrefs = {
	favorites: string[];
	recents: string[];
};

const PREF_PATH = PATHS.COMMAND_PREFS_FILE;

function loadPrefs(): CommandPrefs {
	try {
		if (!existsSync(PREF_PATH)) return { favorites: [], recents: [] };
		const raw = readFileSync(PREF_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return {
			favorites: Array.isArray(parsed.favorites)
				? parsed.favorites.filter((x: unknown) => typeof x === "string")
				: [],
			recents: Array.isArray(parsed.recents)
				? parsed.recents.filter((x: unknown) => typeof x === "string")
				: [],
		};
	} catch {
		return { favorites: [], recents: [] };
	}
}

function savePrefs(prefs: CommandPrefs): void {
	mkdirSync(dirname(PREF_PATH), { recursive: true });
	writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2), "utf8");
}

export async function handleCommandPrefs(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
): Promise<void> {
	const { corsHeaders } = context;
	try {
		if (req.method === "GET") {
			const prefs = loadPrefs();
			sendJson(res, 200, prefs, corsHeaders, req);
			return;
		}
		if (req.method === "POST") {
			let body: Record<string, unknown>;
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of req) {
					chunks.push(chunk as Buffer);
				}
				const bodyRaw = Buffer.concat(chunks).toString("utf8");
				body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
			} catch {
				sendJson(res, 400, { error: "Invalid JSON payload" }, corsHeaders, req);
				return;
			}
			const prefs: CommandPrefs = {
				favorites: Array.isArray(body.favorites)
					? body.favorites.filter((x: unknown) => typeof x === "string")
					: [],
				recents: Array.isArray(body.recents)
					? body.recents.filter((x: unknown) => typeof x === "string")
					: [],
			};
			savePrefs(prefs);
			sendJson(res, 200, { ok: true }, corsHeaders, req);
			return;
		}
		res.writeHead(405, corsHeaders);
		res.end();
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}
