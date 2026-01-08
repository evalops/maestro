# Composer Web UI

Beautiful, modern web interface for Composer AI coding assistant.

## Features

### 🎨 Beautiful Design
- **Glass morphism effects** with backdrop blur and transparency
- **Animated backgrounds** with gradient pulses
- **Smooth animations** and micro-interactions
- **Modern color palette** with consistent theming
- **Responsive layout** that works on mobile and desktop

### 💬 Session Management
- **Session sidebar** showing all your conversations
- **Create new sessions** with one click
- **Resume previous sessions** from the sidebar
- **Session metadata** showing date and message count
- **Persistent history** across page reloads

### ⚡ Enhanced Messages
- **Rich markdown rendering** with syntax highlighting
- **Code blocks** with copy-to-clipboard buttons
- **Tool execution indicators** showing which tools were used
- **Timestamp display** with smart formatting (e.g., "2h ago")
- **Avatar bubbles** with gradient effects
- **Hover animations** on message bubbles

### ⌨️ Smart Input
- **Auto-growing textarea** that expands as you type
- **Character counter** that appears when needed
- **Keyboard shortcuts**: Enter to send, Shift+Enter for new line
- **Visual feedback** with focus states and animations
- **Disabled state** while AI is thinking

### 🤖 AI Integration
- **Streaming responses** with real-time updates
- **Model selector** in header
- **Error handling** with beautiful error messages
- **Loading states** with animated spinners
- **Tool usage tracking** (coming soon)

## Getting Started

### Development

```bash
# From the root directory
npm run web:dev

# Or from the web package
cd packages/web
npm run dev
```

This will start:
- The web server on `http://localhost:8080`
- Vite dev server with hot module reloading (default: `http://localhost:3000`)

### Production Build

```bash
cd packages/web
npm run build
```

### Running the Server

```bash
# From root
npm run web

# Or via the CLI
composer web

# Or with custom port
PORT=3000 npm run web
```

## Architecture

### Components

- **`composer-chat.ts`** - Main chat interface with sidebar and session management
- **`composer-message.ts`** - Message display with markdown rendering and animations
- **`composer-input.ts`** - Smart input field with auto-grow and shortcuts
- **`model-selector.ts`** - Model selection dialog

### Services

- **`api-client.ts`** - HTTP client for backend API with session support

### Styling

All components use Lit's `css` tagged template literals for scoped styling. Key features:

- CSS variables for theming
- Animation keyframes for smooth transitions
- Responsive design with mobile breakpoints
- Custom scrollbar styling
- Glass morphism effects with `backdrop-filter`

## API Endpoints

The web UI communicates with these backend endpoints:

### Chat
- `POST /api/chat` - Send a message and receive streaming response
  ```json
  {
    "model": "claude-sonnet-4-5",
    "messages": [...],
    "sessionId": "optional-session-id"
  }
  ```

### Models
- `GET /api/models` - List available AI models
- `GET /api/model` - Get current model
- `POST /api/model` - Set current model

### Sessions
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get specific session
- `POST /api/sessions` - Create new session
- `DELETE /api/sessions/:id` - Delete session

## Customization

### Theming

Edit CSS variables in `index.html`:

```css
:root {
  --bg-primary: #0a0e14;
  --bg-secondary: #161b22;
  --text-primary: #e6edf3;
  --accent-color: #2f81f7;
  /* ... more variables */
}
```

### API Endpoint

Change the API endpoint in `index.html`:

```html
<composer-chat 
    api-endpoint="http://your-api:8080"
    model="your-model">
</composer-chat>
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Requires:
- ES2020 features
- CSS backdrop-filter
- CSS custom properties
- Web Components v1

## Performance

- **Code splitting** via Vite
- **Lazy loading** of syntax highlighting
- **Efficient re-renders** with Lit's reactive properties
- **Virtual scrolling** for long conversations

## Security

- **XSS protection** via HTML sanitization
- **CORS** enabled for local development
- **Content Security Policy** recommended for production
- **Input validation** on all user inputs

## Roadmap

- [ ] Dark/light theme toggle
- [ ] Session search and filtering
- [ ] Export sessions as Markdown/HTML
- [ ] Voice input support
- [ ] File upload for context
- [ ] Collaborative sessions
- [ ] Keyboard shortcuts panel
- [ ] Accessibility improvements
- [ ] Offline support with Service Worker

## Contributing

See the main [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

Same as main Composer project.
