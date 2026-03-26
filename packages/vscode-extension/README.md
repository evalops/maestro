# Maestro for VS Code

Use Maestro's deterministic AI assistant directly inside VS Code. Chat with AI, execute commands, and get intelligent code assistance without leaving your editor.

## Features

- **AI Chat Sidebar**: Interactive chat panel in the VS Code sidebar
- **Code-Aware Assistance**: Get context-aware help for your current project
- **Model Selection**: Choose from multiple AI providers (Anthropic, OpenAI, Google, etc.)
- **Deterministic Tooling**: All operations use transparent, git-aware helpers

## Requirements

- VS Code 1.90.0 or higher
- A running Maestro API server (see [Maestro CLI](https://github.com/evalops/maestro))

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Start the Maestro API server:
   ```bash
   maestro web
   ```
3. Open the Maestro sidebar from the Activity Bar
4. Start chatting with the AI assistant

## Extension Settings

This extension contributes the following settings:

- `composer.apiEndpoint`: URL of the Maestro API server (default: `http://localhost:8080`)
- `composer.model`: Model ID to use for chat generation (default: `claude-sonnet-4-5`)

## Commands

- **Maestro: Open Assistant Panel** - Open the Maestro chat panel
- **Maestro: Open Documentation** - Open Maestro documentation
- **Clear Chat** - Clear the current chat history

## Links

- [Documentation](https://github.com/evalops/maestro#readme)
- [Report Issues](https://github.com/evalops/maestro/issues)
- [Changelog](https://github.com/evalops/maestro/blob/main/CHANGELOG.md)

## License

MIT
