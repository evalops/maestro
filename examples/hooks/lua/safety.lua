-- Safety Hook for Composer
--
-- Blocks dangerous shell commands before they execute.
-- This is a Lua hook that runs on PreToolUse events for Bash.
--
-- Usage: Add to hooks.toml:
--   [[hooks]]
--   event = "PreToolUse"
--   tools = ["Bash"]
--   lua_file = "~/.composer/hooks/safety.lua"

-- Dangerous command patterns to block
local dangerous_patterns = {
    "rm %-rf /",
    "rm %-rf %*",
    "rm %-rf ~",
    "mkfs%.",
    "dd if=/dev/zero",
    "> /dev/sda",
    "chmod %-R 777 /",
    ":(){ :|:& };:",  -- fork bomb
    "wget .* | sh",
    "curl .* | sh",
}

-- Check if command matches any dangerous pattern
local function is_dangerous(command)
    for _, pattern in ipairs(dangerous_patterns) do
        if command:match(pattern) then
            return true, pattern
        end
    end
    return false, nil
end

-- Main hook logic
if tool_name == "Bash" or tool_name == "bash" then
    local command = tool_input.command or ""

    local dangerous, pattern = is_dangerous(command)
    if dangerous then
        return {
            block = true,
            reason = string.format("Blocked dangerous command pattern: %s", pattern)
        }
    end
end

-- Default: continue execution
return { continue = true }
