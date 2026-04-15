-- Logging Hook for Composer
--
-- Logs all tool executions to a file for auditing.
--
-- Usage: Add to hooks.toml:
--   [[hooks]]
--   event = "PreToolUse"
--   lua_file = "~/.composer/hooks/logging.lua"

-- Log file path (set via environment or default)
local log_file = os.getenv("COMPOSER_HOOK_LOG") or
    (os.getenv("HOME") or ".") .. "/.composer/hook-activity.log"

-- Format timestamp
local function timestamp()
    return os.date("%Y-%m-%dT%H:%M:%S")
end

-- Append to log file
local function log(message)
    local f = io.open(log_file, "a")
    if f then
        f:write(string.format("[%s] %s\n", timestamp(), message))
        f:close()
    end
end

-- Truncate long strings
local function truncate(s, max_len)
    if #s > max_len then
        return s:sub(1, max_len) .. "..."
    end
    return s
end

-- Convert value to string for logging
local function to_string(v)
    if type(v) == "table" then
        -- Simple JSON-like representation
        local parts = {}
        for k, val in pairs(v) do
            table.insert(parts, string.format("%s=%s", k, to_string(val)))
        end
        return "{" .. table.concat(parts, ", ") .. "}"
    elseif type(v) == "string" then
        return '"' .. truncate(v, 100) .. '"'
    else
        return tostring(v)
    end
end

-- Log the tool call
local input_str = to_string(tool_input)
local session = session_id or "no-session"

log(string.format(
    "Tool=%s Session=%s CallId=%s Input=%s",
    tool_name,
    session,
    tool_call_id or "unknown",
    truncate(input_str, 200)
))

-- Continue execution (logging is non-blocking)
return { continue = true }
