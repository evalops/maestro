# @evalops/composer-web

Web UI for Composer - A browser-based AI coding assistant interface.

## Features

- **Modern Web Components**: Built with Lit for lightweight, reusable components
- **Real-time Streaming**: Live response streaming from LLM providers
- **Syntax Highlighting**: Code blocks with highlight.js
- **Markdown Rendering**: Rich text formatting with marked
- **Model Selection**: Switch between different AI models
- **Session Management**: Save and resume chat sessions
- **Dark Theme**: Professional dark mode interface

## Installation

```bash
npm install @evalops/composer-web
```

## Quick Start

### Standalone Application

```bash
npm run dev
```

Opens browser at http://localhost:3000

### Embedded in Your App

```typescript
import "@evalops/composer-web";

// Add to your HTML
<composer-chat api-endpoint="http://localhost:8080"></composer-chat>
```

## Components

### `<composer-chat>`

Main chat interface component.

**Attributes:**
- `api-endpoint` - Backend API URL
- `model` - Default model to use
- `theme` - Color theme (dark/light)

**Example:**

```html
<composer-chat 
  api-endpoint="http://localhost:8080"
  model="claude-sonnet-4-5"
  theme="dark">
</composer-chat>
```

### `<composer-message>`

Individual message display component.

**Attributes:**
- `role` - Message role (user/assistant/system)
- `content` - Message text content
- `timestamp` - ISO timestamp string

### `<composer-input>`

Message input component with keyboard shortcuts.

**Features:**
- Multi-line support (Shift+Enter)
- File attachments
- Command shortcuts (/)

### `<model-selector>`

Interactive model selection dialog.

**Features:**
- Filter by provider
- Search models
- Display model capabilities

## Architecture

```
packages/web/
├── src/
│   ├── components/        # Web Components
│   │   ├── composer-chat.ts
│   │   ├── composer-message.ts
│   │   ├── composer-input.ts
│   │   └── model-selector.ts
│   ├── services/          # API clients
│   │   ├── api-client.ts
│   │   └── websocket-client.ts
│   ├── styles/            # Shared styles
│   │   └── theme.css
│   └── index.ts           # Entry point
├── index.html             # Demo page
└── vite.config.ts         # Build config
```

## Development

### Run Development Server

```bash
npm run dev
```

### Build for Production

```bash
npm run build
```

### Run Tests

```bash
npm test
```

## Styling

Components use CSS custom properties for theming:

```css
composer-chat {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --text-primary: #d4d4d4;
  --text-secondary: #969696;
  --accent-color: #0e639c;
  --border-color: #3e3e42;
}
```

## API Integration

The web UI expects a backend API with these endpoints:

### POST /api/chat

Send a message and receive streaming response.

**Request:**
```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

**Response:**
Server-sent events stream with JSON chunks.

### GET /api/models

List available models.

**Response:**
```json
{
  "models": [
    {
      "id": "claude-sonnet-4-5",
      "provider": "anthropic",
      "name": "Claude Sonnet 4.5"
    }
  ]
}
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## License

MIT - see LICENSE file for details.
