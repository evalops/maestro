package com.evalops.composer.toolwindow

import com.evalops.composer.api.ComposerToolCall
import java.net.URI

private fun getStringArg(args: Map<String, Any?>?, keys: List<String>): String? {
    if (args == null) return null
    for (key in keys) {
        val value = args[key]
        when (value) {
            is String -> if (value.isNotBlank()) return value.trim()
            is List<*> -> {
                val first = value.firstOrNull { it is String && it.isNotBlank() } as? String
                if (first != null) return first.trim()
            }
        }
    }
    return null
}

private fun truncateLabel(value: String, max: Int = 48): String {
    val normalized = value.replace(Regex("\\s+"), " ").trim()
    if (normalized.length <= max) return normalized
    return normalized.take(max - 3).trimEnd() + "..."
}

private fun quoteLabel(value: String, max: Int = 32): String {
    return "\"${truncateLabel(value, max)}\""
}

private fun shortUrlLabel(raw: String): String {
    return try {
        val parsed = URI(raw)
        val host = parsed.host ?: raw
        val path = if (parsed.path == "/") "" else (parsed.path ?: "")
        truncateLabel("$host$path", 40)
    } catch (_: Exception) {
        truncateLabel(raw, 40)
    }
}

private fun shortPathLabel(raw: String): String {
    val normalized = raw.trim().replace("\\", "/")
    if (normalized.isEmpty()) return "file"
    if (Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(normalized)) {
        return shortUrlLabel(normalized)
    }
    if (normalized == "." || normalized == "..") {
        return normalized
    }
    val isDirectory = normalized.endsWith("/")
    val trimmed = normalized.trimEnd('/')
    val parts = trimmed.split("/").filter { it.isNotBlank() }
    if (parts.isEmpty()) {
        return normalized
    }
    val leaf = parts.last()
    return truncateLabel(leaf, 32) + if (isDirectory) "/" else ""
}

private fun humanizeToolName(toolName: String): String {
    val trimmed = toolName.trim()
    if (trimmed.isEmpty()) return "tool"
    val mcpParts = trimmed.split("__").filter { it.isNotBlank() }
    if (trimmed.startsWith("mcp__") && mcpParts.size >= 3) {
        return mcpParts.drop(2).joinToString(" ").replace(Regex("[._-]+"), " ")
    }
    return trimmed.replace(Regex("[._-]+"), " ")
}

private fun sentenceCase(value: String): String {
    if (value.isEmpty()) return value
    return value.replaceFirstChar { it.uppercase() }
}

fun summarizeToolCall(tool: ComposerToolCall): String {
    val normalized = tool.name.trim().lowercase()
    val args = tool.args
    val filePath = getStringArg(
        args,
        listOf("file_path", "filePath", "path", "target_path", "targetPath", "filename")
    )
    val directory = getStringArg(args, listOf("directory", "dir", "cwd"))
    val pattern = getStringArg(args, listOf("pattern", "query", "search", "regex"))
    val command = getStringArg(args, listOf("command", "cmd", "script"))
    val url = getStringArg(args, listOf("url", "uri"))

    val summary = when (normalized) {
        "read" -> "Read ${shortPathLabel(filePath ?: "file")}"
        "write", "append", "create_file", "createfile" -> "Wrote ${shortPathLabel(filePath ?: "file")}"
        "edit", "multi_edit", "str_replace_based_edit", "apply_patch" -> "Edited ${shortPathLabel(filePath ?: "file")}"
        "delete", "remove", "unlink" -> "Deleted ${shortPathLabel(filePath ?: "file")}"
        "list", "ls" -> "Listed ${shortPathLabel(directory ?: filePath ?: "directory")}"
        "glob" -> if (pattern != null) {
            "Matched ${quoteLabel(pattern)}"
        } else {
            "Scanned ${shortPathLabel(directory ?: "workspace")}"
        }
        "grep", "search", "search_files" -> if (pattern != null) {
            "Searched for ${quoteLabel(pattern)}"
        } else {
            "Searched files"
        }
        "bash", "shell", "exec_command" -> if (command != null) {
            "Ran ${truncateLabel(command, 52)}"
        } else {
            "Ran command"
        }
        "webfetch", "fetch", "open" -> "Fetched ${shortUrlLabel(url ?: filePath ?: "resource")}"
        "websearch", "search_query" -> if (pattern != null) {
            "Searched web for ${quoteLabel(pattern)}"
        } else {
            "Searched web"
        }
        else -> "Ran ${truncateLabel(humanizeToolName(tool.name), 40)}"
    }

    return sentenceCase(summary)
}
