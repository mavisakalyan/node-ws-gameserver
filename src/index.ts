import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeMessage, encodeMessage, ErrorCodes, PROTOCOL_VERSION } from './protocol.js';
import { Room } from './room.js';
import { RateLimiter } from './rate-limit.js';
import { handleHealthRequest } from './health.js';

// ─── Configuration ───────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 30000;
const MAX_MESSAGES_PER_SECOND = Number(process.env.MAX_MESSAGES_PER_SECOND) || 60;
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM) || 50;

// ─── State ───────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const rateLimiter = new RateLimiter(MAX_MESSAGES_PER_SECOND);

/** Maps WebSocket → { clientId, roomId } */
const clientMeta = new WeakMap<WebSocket, { clientId: string; roomId: string }>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, MAX_PLAYERS_PER_ROOM);
    rooms.set(roomId, room);
  }
  return room;
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = createServer((req, res) => {
  // Handle /health and /metrics
  if (handleHealthRequest(req, res, rooms)) return;

  // Default 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── WebSocket Server ────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Origin check
  if (ALLOWED_ORIGINS[0] !== '*') {
    const origin = req.headers.origin || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // Parse room ID from URL: /ws/:roomId (default "lobby")
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // Expect /ws or /ws/:roomId
  if (pathParts[0] !== 'ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const roomId = pathParts[1] || 'lobby';
  const clientId = randomUUID();

  wss.handleUpgrade(req, socket, head, (ws) => {
    clientMeta.set(ws, { clientId, roomId });
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WebSocket) => {
  const meta = clientMeta.get(ws);
  if (!meta) {
    ws.close(1011, 'Internal error');
    return;
  }

  const { clientId, roomId } = meta;

  // ─── Auto-join room on connect ──────────────────────────
  const room = getOrCreateRoom(roomId);
  const joined = room.join(clientId, ws);
  if (!joined) {
    ws.close(1013, 'Room full');
    return;
  }

  // ─── KeepAlive ────────────────────────────────────────────
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, KEEPALIVE_MS);

  // ─── Message Handler ──────────────────────────────────────
  ws.on('message', (raw: Buffer) => {
    // Rate limiting
    if (!rateLimiter.allow(clientId)) {
      ws.send(encodeMessage({
        type: 'error',
        code: ErrorCodes.RATE_LIMITED,
        message: 'Rate limited',
      }));
      return;
    }

    const message = decodeMessage(raw);
    if (!message) {
      ws.send(encodeMessage({
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Invalid message format',
      }));
      return;
    }

    // Handle hello (optional protocol version check)
    if (message.type === 'hello') {
      const clientVersion = message.protocolVersion;
      if (typeof clientVersion === 'number' && clientVersion !== PROTOCOL_VERSION) {
        ws.send(encodeMessage({
          type: 'error',
          code: ErrorCodes.BAD_PROTOCOL,
          message: `Protocol mismatch. Server=${PROTOCOL_VERSION}, Client=${clientVersion}`,
        }));
        ws.close(1008, 'BAD_PROTOCOL');
      }
      return; // hello is consumed, not relayed
    }

    // Handle ping
    if (message.type === 'ping' && typeof message.nonce === 'string') {
      ws.send(encodeMessage({
        type: 'pong',
        nonce: message.nonce,
        serverTime: Date.now(),
      }));
      return;
    }

    // Everything else is game data — relay to peers
    room.relay(clientId, message);
  });

  // ─── Disconnect ───────────────────────────────────────────
  ws.on('close', () => {
    clearInterval(pingInterval);
    rateLimiter.remove(clientId);
    const r = rooms.get(roomId);
    if (r) {
      r.leave(clientId);
      // Clean up empty rooms (except lobby)
      if (r.playerCount === 0 && roomId !== 'lobby') {
        r.destroy();
        rooms.delete(roomId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] Client ${clientId} error:`, err.message);
  });
});

// ─── Periodic metrics update ─────────────────────────────────────

setInterval(() => {
  for (const room of rooms.values()) {
    room.updateMetrics();
  }
}, 1000);

// ─── Rate limiter cleanup ────────────────────────────────────────

setInterval(() => {
  rateLimiter.cleanup();
}, 10_000);

// ─── Start ───────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[node-ws-gameserver] Listening on port ${PORT}`);
  console.log(`[node-ws-gameserver] WebSocket endpoint: ws://localhost:${PORT}/ws/:roomId`);
  console.log(`[node-ws-gameserver] Health: http://localhost:${PORT}/health`);
  console.log(`[node-ws-gameserver] Metrics: http://localhost:${PORT}/metrics`);
  console.log(`[node-ws-gameserver] Config: ${MAX_PLAYERS_PER_ROOM} max/room, ${MAX_MESSAGES_PER_SECOND} msg/s limit`);
});
