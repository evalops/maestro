import { pathToFileURL } from "node:url";

/**
 * @param {string} moduleUrl
 * @param {string | undefined} [argvPath=process.argv[1]]
 * @returns {boolean}
 */
export function isDirectCliEntrypoint(
	moduleUrl,
	argvPath = process.argv[1],
) {
	return argvPath ? moduleUrl === pathToFileURL(argvPath).href : false;
}
