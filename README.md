# node-ws-gameserver

Production-grade WebSocket game server built with Node.js, TypeScript, and msgpack binary protocol. Designed for realtime multiplayer games and metaverse applications.

[![Deploy on Alternate Futures](https://app.alternatefutures.ai/badge/deploy.svg)](https://app.alternatefutures.ai/deploy/node-ws-gameserver)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/x6i4kh?referralCode=vwwMnH)

## Features

- **Room-based architecture** — `/ws/:roomId` with auto-created rooms and configurable player caps
- **Binary protocol (msgpack)** — ~40% smaller payloads than JSON
- **Server-authoritative tick loop** — Configurable Hz for snapshot broadcasting
- **Player state sync** — Position, rotation, action, and timestamp per player
- **Per-client rate limiting** — Sliding window algorithm
- **KeepAlive ping/pong** — Automatic dead connection detection
- **Origin allowlist** — Configurable CORS protection
- **Health + Metrics endpoints** — `/health` and `/metrics` for monitoring and autoscaling
- **Production Dockerfile** — Multi-stage, non-root user, HEALTHCHECK

## Quick Start

```bash
# Install dependencies
npm install

# Development (with hot reload)
npm run dev

# Production build + start
npm run build
npm start
```

## Docker

```bash
# Build and run
docker compose up --build

# Or manually
docker build -t node-ws-gameserver .
docker run -p 8080:8080 node-ws-gameserver
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins |
| `SNAPSHOT_HZ` | `20` | Tick rate (snapshots/sec) |
| `KEEPALIVE_MS` | `30000` | Ping interval (ms) |
| `MAX_MESSAGES_PER_SECOND` | `60` | Per-client rate limit |
| `MAX_PLAYERS_PER_ROOM` | `50` | Room capacity |

## Protocol

Both `node-ws-gameserver` and [`bun-ws-gameserver`](https://github.com/alternatefutures/bun-ws-gameserver) use the same **msgpack binary protocol**, so clients are backend-agnostic.

### Client → Server

```typescript
{ type: "join",  payload: { displayName: string } }
{ type: "state", payload: { position: {x,y,z}, rotation: {x,y,z,w}, action: string } }
{ type: "chat",  payload: { message: string } }
```

### Server → Client

```typescript
{ type: "snapshot",      payload: { players: Record<id, PlayerState>, timestamp: number } }
{ type: "player_joined", payload: { id: string, displayName: string } }
{ type: "player_left",   payload: { id: string } }
{ type: "chat",          payload: { id: string, message: string } }
{ type: "error",         payload: { code: string, message: string } }
```

### Example Client (browser)

```typescript
import { encode, decode } from '@msgpack/msgpack';

const ws = new WebSocket('ws://localhost:8080/ws/lobby');
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  ws.send(encode({ type: 'join', payload: { displayName: 'Player1' } }));
};

ws.onmessage = (event) => {
  const msg = decode(new Uint8Array(event.data));
  if (msg.type === 'snapshot') {
    // Update game state with msg.payload.players
  }
};

// Send player state at 30fps
setInterval(() => {
  ws.send(encode({
    type: 'state',
    payload: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      action: 'idle',
    },
  }));
}, 33);
```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/ws/:roomId` | WS | WebSocket game connection (default room: "lobby") |
| `/health` | GET | Health check — status, rooms, connections, uptime |
| `/metrics` | GET | Detailed metrics — memory, messages/sec per room |

## Deploy

### Alternate Futures

Click the deploy button at the top, or go to [app.alternatefutures.ai](https://app.alternatefutures.ai) — select this template and deploy to decentralized cloud in one click.

### Railway

1. Fork this repo
2. Connect to Railway
3. Deploy — Railway reads `railway.toml` automatically

### Docker (any host)

```bash
docker build --platform linux/amd64 -t node-ws-gameserver .
docker run -p 8080:8080 -e PORT=8080 node-ws-gameserver
```

## License

MIT
