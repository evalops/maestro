# Composer for VS Code

Use Composer's deterministic AI assistant directly inside VS Code. Chat with AI, execute commands, and get intelligent code assistance without leaving your editor.

## Features

- **AI Chat Sidebar**: Interactive chat panel in the VS Code sidebar
- **Code-Aware Assistance**: Get context-aware help for your current project
- **Model Selection**: Choose from multiple AI providers (Anthropic, OpenAI, Google, etc.)
- **Deterministic Tooling**: All operations use transparent, git-aware helpers

## Requirements

- VS Code 1.90.0 or higher
- A running Composer API server (see [Composer CLI](https://github.com/evalops/composer))

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Start the Composer API server:
   ```bash
   composer web
   ```
3. Open the Composer sidebar from the Activity Bar
4. Start chatting with the AI assistant

## Extension Settings

This extension contributes the following settings:

- `composer.apiEndpoint`: URL of the Composer API server (default: `http://localhost:8080`)
- `composer.model`: Model ID to use for chat generation (default: `claude-sonnet-4-5`)

## Commands

- **Composer: Open Assistant Panel** - Open the Composer chat panel
- **Composer: Open Documentation** - Open Composer documentation
- **Clear Chat** - Clear the current chat history

## Links

- [Documentation](https://github.com/evalops/composer#readme)
- [Report Issues](https://github.com/evalops/composer/issues)
- [Changelog](https://github.com/evalops/composer/blob/main/CHANGELOG.md)

## License

MIT
