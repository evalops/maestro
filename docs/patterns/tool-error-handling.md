# Tool Error Handling Patterns

This document describes the error handling patterns used in Composer tools.

## Overview

Tools can report errors in two ways:

1. **Throwing exceptions** - For fatal/unexpected errors that should abort execution
2. **Using `respond.error()`** - For expected/user-friendly errors that return a structured response

Both patterns result in the same outcome: a `ToolResultMessage` with `isError: true` is sent to the LLM. The difference lies in control flow and error semantics.

## Pattern 1: Throwing Exceptions

Use `throw` for:
- Validation errors that indicate programmer mistakes
- Unexpected system failures
- Errors that should abort the current operation immediately

```typescript
// Schema validation (handled automatically by createTool)
throw new ToolError(
  "Validation failed for tool \"write\":\n  - path: must be string",
  "VALIDATION_ERROR",
  { params }
);

// Parameter validation
if (!params.title) {
  throw new Error("title required for create");
}

// Abort on signal
if (signal?.aborted) {
  throw new Error("Operation aborted");
}

// System errors
throw new Error(`File not found: ${path}`);
```

### ToolError vs Error

- `ToolError` - Use when you want to attach structured details that may be useful for debugging
- `Error` - Use for simple error messages

```typescript
// ToolError with details
throw new ToolError(
  "Command parsing failed",
  "PARSE_ERROR",
  { command, position: 42 }
);

// Simple Error
throw new Error("Git Bash not found");
```

## Pattern 2: Using respond.error()

Use `respond.error()` for:
- Expected error conditions the user should understand
- Errors where you want to provide helpful context
- Partial success scenarios where some operations failed

```typescript
// User-friendly file not found
if (!fileExists) {
  return respond.error(`File not found: ${path}`);
}

// Tool not available
if (!toolMap.has(call.tool)) {
  return respond.error(`Tool not found: ${call.tool}`);
}

// Graceful degradation
try {
  // ... operation
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return respond.error(`Listing ${path} failed: ${message}`);
}
```

## When to Use Which

| Scenario | Pattern | Rationale |
|----------|---------|-----------|
| Invalid schema/params | `throw ToolError` | Validation errors are programming mistakes |
| Signal aborted | `throw Error` | Abort immediately, no cleanup needed |
| File not found (read) | `respond.error()` | Read is done, return friendly message |
| File not found (edit) | `throw Error` | Abort edit chain immediately |
| Tool not found in batch | `respond.error()` | Partial failure, continue with other tools |
| System path blocked | `respond.error()` | Security policy, explain to user |
| Parse error in user input | `respond.error()` | Help user fix their input |
| Edit text not found | `throw Error` | Abort - cannot proceed without match |
| Unexpected crash | `throw Error` | Let transport handle and log |

### Key Decision Factor

The choice depends on **what happens next**:

- **Use `throw`** when the operation cannot proceed and there's nothing else to do
- **Use `respond.error()`** when you want to return a clean result (even if it's an error) and potentially allow the caller to continue

For example, in batch operations:
- Individual tool failures use `respond.error()` so other tools can still run
- Fatal batch configuration errors use `throw` to abort the entire batch

## Transport Behavior

The transport layer handles both patterns identically:

```typescript
// Throwing is caught and converted
.catch(async (error: unknown) => {
  return {
    message: {
      role: "toolResult",
      content: [{ type: "text", text: error.message }],
      details: error instanceof ToolError ? error.details : undefined,
      isError: true,
    },
    isError: true,
  };
})

// respond.error() returns isError: true directly
.then(async (result) => {
  return {
    message: {
      content: result.content,
      isError: result.isError || false,
    },
    isError: result.isError || false,
  };
})
```

## Batch Tool Behavior

In batch operations, errors are collected per-tool:

```typescript
// Each tool result has success/isError
results.push({
  content: [{ type: "text", text: errorMessage }],
  isError: true,
  success: false,
});

// stopOnError: true will halt on first error
if (result.isError && stopOnError) {
  break;
}
```

## Schema Validation

Schema validation is enforced at the tool execution level using AJV:

- Runs automatically when `tool.execute()` is called
- Uses `useDefaults: true` to apply schema defaults
- Throws `ToolError` with code `"VALIDATION_ERROR"` on failure

```typescript
// Automatic validation in createTool
if (ajv && options.schema) {
  const validate = ajv.compile(options.schema);
  if (!validate(params)) {
    throw new ToolError(
      `Validation failed for tool "${options.name}":\n${formatErrors(validate.errors)}`,
      "VALIDATION_ERROR",
      { params }
    );
  }
}
```

## Best Practices

1. **Be consistent within a tool** - Don't mix patterns for similar error types
2. **Provide actionable messages** - Tell users how to fix the problem
3. **Use ToolError for debugging** - Attach details when they help diagnose issues
4. **Don't swallow errors** - Either throw or use respond.error(), never ignore
5. **Check signal.aborted** - Respect cancellation requests promptly
