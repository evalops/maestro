# Web UI Architecture Design

The Web UI provides a browser-based interface for Composer, offering real-time chat, session management, and model selection through WebSocket communication.

## Overview

Key capabilities:

- **Real-Time Streaming**: WebSocket-based message delivery
- **Session Sync**: Synchronized state across tabs/devices
- **Model Selection**: Interactive model/provider switching
- **File Operations**: Browser-based file viewing
- **Responsive Design**: Mobile and desktop support

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Web UI Architecture                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Browser Client                           │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐             │   │
│  │  │ Chat View  │  │ Session    │  │ Settings   │             │   │
│  │  │ - Messages │  │ Selector   │  │ - Model    │             │   │
│  │  │ - Input    │  │ - List     │  │ - Theme    │             │   │
│  │  │ - Tools    │  │ - Search   │  │ - Prefs    │             │   │
│  │  └────────────┘  └────────────┘  └────────────┘             │   │
│  │         │                │                │                  │   │
│  │         └────────────────┼────────────────┘                  │   │
│  │                          ▼                                   │   │
│  │              ┌────────────────────┐                          │   │
│  │              │   WebSocket Client │                          │   │
│  │              │   - Event dispatch │                          │   │
│  │              │   - Reconnection   │                          │   │
│  │              │   - Heartbeat      │                          │   │
│  │              └────────────────────┘                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              │ WebSocket                             │
│                              ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Web Server                               │   │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │   │
│  │  │ Express Routes │  │ WS Handler     │  │ Static Files   │ │   │
│  │  │ - /api/chat    │  │ - Events       │  │ - JS/CSS       │ │   │
│  │  │ - /api/session │  │ - Streaming    │  │ - Assets       │ │   │
│  │  │ - /api/model   │  │ - RPC          │  │                │ │   │
│  │  └────────────────┘  └────────────────┘  └────────────────┘ │   │
│  │         │                    │                               │   │
│  │         └────────────────────┘                               │   │
│  │                    │                                         │   │
│  │                    ▼                                         │   │
│  │         ┌────────────────────┐                               │   │
│  │         │      Agent         │                               │   │
│  │         │  (shared instance) │                               │   │
│  │         └────────────────────┘                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Server Components

### Web Server (`src/web-server.ts`)

```typescript
class ComposerWebServer {
  private app: Express;
  private wss: WebSocketServer;
  private agent: Agent;
  private connections: Map<string, WebSocket> = new Map();

  constructor(agent: Agent, port: number) {
    this.agent = agent;
    this.app = express();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    // API routes
    this.app.post("/api/chat", this.handleChat.bind(this));
    this.app.get("/api/sessions", this.handleGetSessions.bind(this));
    this.app.post("/api/sessions", this.handleCreateSession.bind(this));
    this.app.get("/api/models", this.handleGetModels.bind(this));
    this.app.post("/api/model", this.handleSetModel.bind(this));

    // Static files
    this.app.use(express.static("dist/web"));
  }

  private setupWebSocket(): void {
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws, req) => {
      const connectionId = generateId();
      this.connections.set(connectionId, ws);

      // Subscribe to agent events
      const unsubscribe = this.agent.subscribe(event => {
        this.broadcastEvent(event);
      });

      ws.on("close", () => {
        this.connections.delete(connectionId);
        unsubscribe();
      });

      ws.on("message", (data) => {
        this.handleWebSocketMessage(connectionId, data);
      });
    });
  }
}
```

### WebSocket Protocol

```typescript
// Client -> Server messages
type ClientMessage =
  | { type: "prompt"; content: string; attachments?: Attachment[] }
  | { type: "abort" }
  | { type: "subscribe"; events: string[] }
  | { type: "ping" };

// Server -> Client messages
type ServerMessage =
  | { type: "agent_event"; event: AgentEvent }
  | { type: "state_sync"; state: Partial<AgentState> }
  | { type: "error"; message: string }
  | { type: "pong" };
```

### Event Broadcasting

```typescript
class EventBroadcaster {
  private connections: Map<string, WebSocket>;

  broadcastEvent(event: AgentEvent): void {
    const message = JSON.stringify({
      type: "agent_event",
      event
    });

    for (const [id, ws] of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  broadcastToConnection(connectionId: string, message: ServerMessage): void {
    const ws = this.connections.get(connectionId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
```

## Client Components

### WebSocket Client

```typescript
// src/server/websocket-client.ts
class ComposerWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private listeners: Map<string, Set<EventListener>> = new Map();

  connect(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit("connected");
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.attemptReconnect();
    };
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "agent_event":
        this.emit("agent_event", message.event);
        break;
      case "state_sync":
        this.emit("state_sync", message.state);
        break;
      case "pong":
        this.lastPong = Date.now();
        break;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("disconnected");
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    setTimeout(() => {
      this.connect(this.url);
    }, delay);
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
```

### Chat View

```typescript
// src/server/components/ChatView.tsx
function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const wsClient = useWebSocketClient();

  useEffect(() => {
    wsClient.on("agent_event", handleAgentEvent);
    return () => wsClient.off("agent_event", handleAgentEvent);
  }, []);

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "message_start":
        setIsStreaming(true);
        setMessages(prev => [...prev, {
          id: event.message.id,
          role: "assistant",
          content: "",
          toolCalls: []
        }]);
        break;

      case "content_block_delta":
        setMessages(prev => {
          const last = prev[prev.length - 1];
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + event.text }
          ];
        });
        break;

      case "tool_execution_start":
        // Add tool call to current message
        break;

      case "message_end":
        setIsStreaming(false);
        break;
    }
  }

  async function handleSubmit() {
    if (!input.trim() || isStreaming) return;

    setMessages(prev => [...prev, {
      id: generateId(),
      role: "user",
      content: input
    }]);

    wsClient.send({ type: "prompt", content: input });
    setInput("");
  }

  return (
    <div className="chat-view">
      <MessageList messages={messages} />
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={isStreaming}
      />
    </div>
  );
}
```

### Message Rendering

```typescript
// src/server/components/MessageList.tsx
function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="message-list">
      {messages.map(message => (
        <MessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}

function MessageItem({ message }: { message: Message }) {
  return (
    <div className={`message message-${message.role}`}>
      <Avatar role={message.role} />
      <div className="message-content">
        <MarkdownRenderer content={message.content} />
        {message.toolCalls?.map(toolCall => (
          <ToolCallCard key={toolCall.id} toolCall={toolCall} />
        ))}
      </div>
    </div>
  );
}
```

### Tool Call Cards

```typescript
// src/server/components/ToolCallCard.tsx
function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-call-card">
      <div
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <ToolIcon name={toolCall.name} />
        <span className="tool-name">{toolCall.name}</span>
        {toolCall.status === "running" && <Spinner />}
        {toolCall.status === "success" && <CheckIcon />}
        {toolCall.status === "error" && <ErrorIcon />}
      </div>

      {expanded && (
        <div className="tool-call-details">
          <div className="tool-call-input">
            <h4>Input</h4>
            <CodeBlock language="json">
              {JSON.stringify(toolCall.input, null, 2)}
            </CodeBlock>
          </div>

          {toolCall.output && (
            <div className="tool-call-output">
              <h4>Output</h4>
              <ToolOutputRenderer
                name={toolCall.name}
                output={toolCall.output}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

## State Management

### Application State

```typescript
// src/server/state/store.ts
interface AppState {
  // Connection
  connectionStatus: "connecting" | "connected" | "disconnected";

  // Agent state
  messages: Message[];
  isStreaming: boolean;
  currentModel: Model | null;
  thinkingLevel: ThinkingLevel;

  // Session
  currentSession: Session | null;
  sessions: SessionMetadata[];

  // UI
  sidebarOpen: boolean;
  theme: "light" | "dark" | "system";
}

const useStore = create<AppState>((set, get) => ({
  // Initial state
  connectionStatus: "connecting",
  messages: [],
  isStreaming: false,
  // ...

  // Actions
  appendMessage: (message) => set(state => ({
    messages: [...state.messages, message]
  })),

  updateLastMessage: (content) => set(state => ({
    messages: [
      ...state.messages.slice(0, -1),
      { ...state.messages[state.messages.length - 1], content }
    ]
  })),

  setStreaming: (isStreaming) => set({ isStreaming }),

  syncState: (serverState) => set(state => ({
    ...state,
    ...serverState
  }))
}));
```

### State Synchronization

```typescript
// src/server/state/sync.ts
function useStateSync() {
  const wsClient = useWebSocketClient();
  const store = useStore();

  useEffect(() => {
    wsClient.on("state_sync", (serverState) => {
      store.syncState(serverState);
    });

    // Request initial state on connect
    wsClient.on("connected", () => {
      wsClient.send({ type: "get_state" });
    });
  }, []);
}
```

## Session Management

### Session List

```typescript
// src/server/components/SessionList.tsx
function SessionList() {
  const { sessions, currentSession, loadSession } = useStore();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredSessions = sessions.filter(session =>
    session.summary.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="session-list">
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search sessions..."
      />

      {filteredSessions.map(session => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === currentSession?.id}
          onClick={() => loadSession(session.id)}
        />
      ))}
    </div>
  );
}
```

### Session Loading

```typescript
async function loadSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  const session = await response.json();

  store.setState({
    currentSession: session,
    messages: session.messages
  });

  // Notify server of session switch
  wsClient.send({
    type: "switch_session",
    sessionId
  });
}
```

## Model Selection

```typescript
// src/server/components/ModelSelector.tsx
function ModelSelector() {
  const { currentModel, setModel } = useStore();
  const [models, setModels] = useState<Model[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    fetch("/api/models")
      .then(res => res.json())
      .then(setModels);
  }, []);

  async function handleSelectModel(model: Model) {
    await fetch("/api/model", {
      method: "POST",
      body: JSON.stringify({ model: `${model.provider}/${model.id}` })
    });

    setModel(model);
    setIsOpen(false);
  }

  return (
    <Dropdown open={isOpen} onOpenChange={setIsOpen}>
      <DropdownTrigger>
        {currentModel?.name ?? "Select Model"}
      </DropdownTrigger>
      <DropdownContent>
        {models.map(model => (
          <DropdownItem
            key={`${model.provider}/${model.id}`}
            onClick={() => handleSelectModel(model)}
          >
            <ModelIcon provider={model.provider} />
            {model.name}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
```

## Styling

### Theme System

```typescript
// src/server/theme/index.ts
const themes = {
  light: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    primary: "#6366f1",
    secondary: "#8b5cf6",
    border: "#e5e7eb",
    // ...
  },
  dark: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    primary: "#818cf8",
    secondary: "#a78bfa",
    border: "#27272a",
    // ...
  }
};

function useTheme() {
  const { theme } = useStore();

  const resolvedTheme = theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;

  return themes[resolvedTheme];
}
```

## Mobile Support

```typescript
// src/server/hooks/useMobile.ts
function useMobile() {
  const [isMobile, setIsMobile] = useState(
    window.innerWidth < 768
  );

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return isMobile;
}

// Usage in layout
function Layout({ children }) {
  const isMobile = useMobile();
  const { sidebarOpen } = useStore();

  return (
    <div className="layout">
      {(!isMobile || sidebarOpen) && <Sidebar />}
      <main className={isMobile ? "mobile" : ""}>
        {children}
      </main>
    </div>
  );
}
```

## Related Documentation

- [Agent State Machine](AGENT_STATE_MACHINE.md) - Server-side agent
- [TUI Rendering](TUI_RENDERING.md) - Terminal UI comparison
- [Session Persistence](SESSION_PERSISTENCE.md) - Session storage
