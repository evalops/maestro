# LSP Integration Design

The Language Server Protocol (LSP) integration provides IDE-like features including diagnostics, hover information, and code completion suggestions.

## Overview

LSP capabilities:

- **Diagnostics**: Error and warning detection from language servers
- **Hover Information**: Type information and documentation
- **Code Completion**: Context-aware suggestions
- **Workspace Awareness**: Multi-root workspace support
- **Context Injection**: LSP diagnostics in agent context

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      LSP Architecture                                │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    LSP Manager                               │    │
│  │  - Language server discovery                                │    │
│  │  - Server lifecycle management                              │    │
│  │  - Request routing                                          │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           ▼                  ▼                  ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ TypeScript LS  │  │ Python LS      │  │ Rust LS        │        │
│  │ (tsserver)     │  │ (pylsp)        │  │ (rust-analyzer)│        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Diagnostic Collector                       │    │
│  │  - Error aggregation                                        │    │
│  │  - Severity filtering                                       │    │
│  │  - Source file mapping                                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  Context Source Integration                  │    │
│  │  - Agent system prompt injection                            │    │
│  │  - Diagnostic summary generation                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Language Server Configuration

### Server Registry

```typescript
// src/lsp/registry.ts
interface LanguageServerConfig {
  id: string;
  name: string;
  languages: string[];
  command: string;
  args?: string[];
  rootPatterns?: string[];  // Files that indicate project root
  initializationOptions?: Record<string, unknown>;
}

const LANGUAGE_SERVERS: LanguageServerConfig[] = [
  {
    id: "typescript",
    name: "TypeScript Language Server",
    languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootPatterns: ["tsconfig.json", "jsconfig.json", "package.json"]
  },
  {
    id: "python",
    name: "Python Language Server",
    languages: ["python"],
    command: "pylsp",
    rootPatterns: ["pyproject.toml", "setup.py", "requirements.txt"]
  },
  {
    id: "rust",
    name: "Rust Analyzer",
    languages: ["rust"],
    command: "rust-analyzer",
    rootPatterns: ["Cargo.toml"]
  },
  {
    id: "go",
    name: "Go Language Server",
    languages: ["go"],
    command: "gopls",
    rootPatterns: ["go.mod", "go.sum"]
  }
];
```

### Server Discovery

```typescript
// src/lsp/discovery.ts
class LanguageServerDiscovery {
  async findAvailableServers(): Promise<LanguageServerConfig[]> {
    const available: LanguageServerConfig[] = [];

    for (const config of LANGUAGE_SERVERS) {
      if (await this.isServerInstalled(config)) {
        available.push(config);
      }
    }

    return available;
  }

  private async isServerInstalled(config: LanguageServerConfig): Promise<boolean> {
    try {
      await exec(`which ${config.command}`);
      return true;
    } catch {
      return false;
    }
  }

  async findServerForFile(filePath: string): Promise<LanguageServerConfig | null> {
    const extension = path.extname(filePath).slice(1);
    const language = this.extensionToLanguage(extension);

    if (!language) return null;

    const available = await this.findAvailableServers();
    return available.find(s => s.languages.includes(language)) ?? null;
  }

  private extensionToLanguage(ext: string): string | null {
    const mapping: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      py: "python",
      rs: "rust",
      go: "go"
    };
    return mapping[ext] ?? null;
  }
}
```

## LSP Manager

### Server Lifecycle

```typescript
// src/lsp/manager.ts
class LspManager {
  private servers: Map<string, LanguageServer> = new Map();
  private diagnostics: Map<string, Diagnostic[]> = new Map();

  async startServer(config: LanguageServerConfig, workspaceRoot: string): Promise<void> {
    if (this.servers.has(config.id)) {
      return;  // Already running
    }

    const server = new LanguageServer(config);
    await server.start(workspaceRoot);

    // Subscribe to diagnostics
    server.onDiagnostics((uri, diagnostics) => {
      this.diagnostics.set(uri, diagnostics);
      this.emit("diagnostics", { uri, diagnostics });
    });

    this.servers.set(config.id, server);
  }

  async stopServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (server) {
      await server.stop();
      this.servers.delete(serverId);
    }
  }

  async stopAllServers(): Promise<void> {
    for (const [id] of this.servers) {
      await this.stopServer(id);
    }
  }

  getServer(serverId: string): LanguageServer | undefined {
    return this.servers.get(serverId);
  }

  getAllDiagnostics(): Map<string, Diagnostic[]> {
    return new Map(this.diagnostics);
  }

  getDiagnosticsForFile(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }
}
```

### Language Server Process

```typescript
// src/lsp/server.ts
class LanguageServer {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private initialized = false;
  private diagnosticListeners: Array<(uri: string, diagnostics: Diagnostic[]) => void> = [];

  constructor(private config: LanguageServerConfig) {}

  async start(workspaceRoot: string): Promise<void> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout!),
      new StreamMessageWriter(this.process.stdin!)
    );

    // Handle notifications
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        for (const listener of this.diagnosticListeners) {
          listener(params.uri, params.diagnostics);
        }
      }
    );

    this.connection.listen();

    // Initialize
    await this.initialize(workspaceRoot);
  }

  private async initialize(workspaceRoot: string): Promise<void> {
    const initResult = await this.connection!.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${workspaceRoot}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },  // Unnecessary, Deprecated
            codeDescriptionSupport: true
          },
          hover: {
            contentFormat: ["markdown", "plaintext"]
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"]
            }
          }
        },
        workspace: {
          workspaceFolders: true
        }
      },
      initializationOptions: this.config.initializationOptions
    });

    await this.connection!.sendNotification("initialized", {});
    this.initialized = true;
  }

  async stop(): Promise<void> {
    if (this.connection) {
      await this.connection.sendRequest("shutdown");
      await this.connection.sendNotification("exit");
    }
    this.process?.kill();
  }

  onDiagnostics(listener: (uri: string, diagnostics: Diagnostic[]) => void): void {
    this.diagnosticListeners.push(listener);
  }

  async openDocument(uri: string, content: string, languageId: string): Promise<void> {
    await this.connection!.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });
  }

  async updateDocument(uri: string, content: string, version: number): Promise<void> {
    await this.connection!.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }]
    });
  }

  async closeDocument(uri: string): Promise<void> {
    await this.connection!.sendNotification("textDocument/didClose", {
      textDocument: { uri }
    });
  }

  async getHover(uri: string, position: Position): Promise<Hover | null> {
    return await this.connection!.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position
    });
  }

  async getCompletions(
    uri: string,
    position: Position
  ): Promise<CompletionList | CompletionItem[]> {
    return await this.connection!.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position
    });
  }
}
```

## Diagnostic Collection

### Diagnostic Interface

```typescript
// src/lsp/types.ts
interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];
}

enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4
}

interface Range {
  start: Position;
  end: Position;
}

interface Position {
  line: number;
  character: number;
}
```

### Diagnostic Collector

```typescript
// src/lsp/diagnostics.ts
class DiagnosticCollector {
  private manager: LspManager;

  constructor(manager: LspManager) {
    this.manager = manager;
  }

  collectAllDiagnostics(): DiagnosticSummary {
    const all = this.manager.getAllDiagnostics();

    let errorCount = 0;
    let warningCount = 0;
    const filesSummary: Array<{
      file: string;
      errors: number;
      warnings: number;
      diagnostics: Diagnostic[];
    }> = [];

    for (const [uri, diagnostics] of all) {
      const filePath = uri.replace("file://", "");
      const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diagnostics.filter(d => d.severity === DiagnosticSeverity.Warning);

      errorCount += errors.length;
      warningCount += warnings.length;

      if (errors.length > 0 || warnings.length > 0) {
        filesSummary.push({
          file: filePath,
          errors: errors.length,
          warnings: warnings.length,
          diagnostics: [...errors, ...warnings]
        });
      }
    }

    return {
      totalErrors: errorCount,
      totalWarnings: warningCount,
      files: filesSummary
    };
  }

  collectForFile(filePath: string): Diagnostic[] {
    const uri = `file://${filePath}`;
    return this.manager.getDiagnosticsForFile(uri);
  }

  formatDiagnosticsForContext(summary: DiagnosticSummary): string {
    if (summary.totalErrors === 0 && summary.totalWarnings === 0) {
      return "";
    }

    const lines: string[] = [
      "## Current Diagnostics",
      ""
    ];

    for (const file of summary.files) {
      const relativePath = path.relative(process.cwd(), file.file);
      lines.push(`### ${relativePath}`);

      for (const diag of file.diagnostics) {
        const severity = diag.severity === DiagnosticSeverity.Error ? "error" : "warning";
        const line = diag.range.start.line + 1;
        lines.push(`- Line ${line}: ${diag.message} (${severity})`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }
}
```

## Context Source Integration

### LSP Context Source

```typescript
// src/lsp/context-source.ts
class LspContextSource implements AgentContextSource {
  name = "lsp";

  private collector: DiagnosticCollector;

  constructor(collector: DiagnosticCollector) {
    this.collector = collector;
  }

  async getSystemPromptAdditions(options?: { signal?: AbortSignal }): Promise<string | null> {
    const summary = this.collector.collectAllDiagnostics();

    if (summary.totalErrors === 0 && summary.totalWarnings === 0) {
      return null;
    }

    return this.collector.formatDiagnosticsForContext(summary);
  }
}
```

## TUI Integration

### Diagnostics View

```typescript
// src/cli-tui/lsp-view.ts
class LspView {
  private collector: DiagnosticCollector;

  render(): string[] {
    const summary = this.collector.collectAllDiagnostics();
    const lines: string[] = [];

    lines.push(chalk.bold("Language Server Diagnostics"));
    lines.push("");

    if (summary.totalErrors === 0 && summary.totalWarnings === 0) {
      lines.push(chalk.green("✓ No errors or warnings"));
      return lines;
    }

    lines.push(`${chalk.red(`${summary.totalErrors} errors`)}, ${chalk.yellow(`${summary.totalWarnings} warnings`)}`);
    lines.push("");

    for (const file of summary.files) {
      const relativePath = path.relative(process.cwd(), file.file);
      lines.push(chalk.bold(relativePath));

      for (const diag of file.diagnostics.slice(0, 5)) {
        const icon = diag.severity === DiagnosticSeverity.Error ? "✖" : "⚠";
        const color = diag.severity === DiagnosticSeverity.Error ? chalk.red : chalk.yellow;
        const line = diag.range.start.line + 1;
        lines.push(`  ${color(icon)} Line ${line}: ${diag.message}`);
      }

      if (file.diagnostics.length > 5) {
        lines.push(`  ... and ${file.diagnostics.length - 5} more`);
      }

      lines.push("");
    }

    return lines;
  }
}
```

### /lsp Command

```typescript
// src/cli-tui/commands/lsp-handlers.ts
async function handleLspCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "status":
      await showLspStatus();
      break;
    case "diagnostics":
      await showDiagnostics();
      break;
    case "restart":
      await restartServers(args[1]);
      break;
    default:
      console.log("Usage: /lsp [status|diagnostics|restart [server]]");
  }
}

async function showLspStatus(): Promise<void> {
  const servers = lspManager.getActiveServers();

  console.log("\n📊 Language Server Status\n");

  if (servers.length === 0) {
    console.log("No language servers running");
    return;
  }

  for (const server of servers) {
    const status = server.isInitialized() ? chalk.green("●") : chalk.yellow("○");
    console.log(`${status} ${server.config.name}`);
    console.log(`  Languages: ${server.config.languages.join(", ")}`);
  }
}

async function showDiagnostics(): Promise<void> {
  const view = new LspView(diagnosticCollector);
  console.log(view.render().join("\n"));
}
```

## Workspace Awareness

### Multi-Root Support

```typescript
// src/lsp/workspace.ts
class LspWorkspaceManager {
  private workspaceFolders: WorkspaceFolder[] = [];

  async addWorkspaceFolder(path: string): Promise<void> {
    const uri = `file://${path}`;
    const name = path.split("/").pop()!;

    this.workspaceFolders.push({ uri, name });

    // Notify all servers
    for (const server of lspManager.getActiveServers()) {
      await server.sendNotification("workspace/didChangeWorkspaceFolders", {
        event: {
          added: [{ uri, name }],
          removed: []
        }
      });
    }
  }

  async removeWorkspaceFolder(path: string): Promise<void> {
    const uri = `file://${path}`;
    const index = this.workspaceFolders.findIndex(f => f.uri === uri);

    if (index !== -1) {
      const removed = this.workspaceFolders.splice(index, 1);

      // Notify all servers
      for (const server of lspManager.getActiveServers()) {
        await server.sendNotification("workspace/didChangeWorkspaceFolders", {
          event: {
            added: [],
            removed
          }
        });
      }
    }
  }

  getWorkspaceFolders(): WorkspaceFolder[] {
    return [...this.workspaceFolders];
  }
}
```

## Error Handling

```typescript
// src/lsp/errors.ts
class LspError extends Error {
  constructor(
    public readonly serverId: string,
    message: string,
    public readonly code?: number
  ) {
    super(`LSP error (${serverId}): ${message}`);
    this.name = "LspError";
  }
}

class LspConnectionError extends LspError {
  constructor(serverId: string, cause: Error) {
    super(serverId, `Connection failed: ${cause.message}`);
    this.name = "LspConnectionError";
  }
}

class LspTimeoutError extends LspError {
  constructor(serverId: string, method: string) {
    super(serverId, `Request timeout: ${method}`);
    this.name = "LspTimeoutError";
  }
}
```

## Related Documentation

- [Context Management](CONTEXT_MANAGEMENT.md) - Context source integration
- [TUI Rendering](TUI_RENDERING.md) - Diagnostics display
- [Tool System](TOOL_SYSTEM.md) - LSP-aware tools
