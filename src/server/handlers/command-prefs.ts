import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { PATHS } from "../../config/constants.js";
import { resolveEnvPath } from "../../utils/path-expansion.js";
import type { WebServerContext } from "../app-context.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import {
	type CommandPrefsUpdateInput,
	CommandPrefsUpdateSchema,
	parseAndValidateJson,
} from "../validation.js";

type CommandPrefs = {
	favorites: string[];
	recents: string[];
};

const getPrefsPath = () =>
	resolveEnvPath(process.env.MAESTRO_COMMAND_PREFS) ?? PATHS.COMMAND_PREFS_FILE;

function loadPrefs(): CommandPrefs {
	try {
		const prefsPath = getPrefsPath();
		if (!existsSync(prefsPath)) return { favorites: [], recents: [] };
		const raw = readFileSync(prefsPath, "utf8");
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
	const prefsPath = getPrefsPath();
	mkdirSync(dirname(prefsPath), { recursive: true });
	writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), "utf8");
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
			const body = await parseAndValidateJson<CommandPrefsUpdateInput>(
				req,
				CommandPrefsUpdateSchema,
			);
			const prefs: CommandPrefs = {
				favorites: body.favorites ?? [],
				recents: body.recents ?? [],
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
