import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeMessage, encodeMessage, ErrorCodes } from './protocol.js';
import { Room } from './room.js';
import { RateLimiter } from './rate-limit.js';
import { handleHealthRequest } from './health.js';

// ─── Configuration ───────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const SNAPSHOT_HZ = Number(process.env.SNAPSHOT_HZ) || 20;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 30000;
const MAX_MESSAGES_PER_SECOND = Number(process.env.MAX_MESSAGES_PER_SECOND) || 60;
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM) || 50;

// ─── State ───────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const rateLimiter = new RateLimiter(MAX_MESSAGES_PER_SECOND);

/** Maps WebSocket → { clientId, roomId, joined } */
const clientMeta = new WeakMap<WebSocket, { clientId: string; roomId: string; joined: boolean }>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, MAX_PLAYERS_PER_ROOM, SNAPSHOT_HZ);
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
    clientMeta.set(ws, { clientId, roomId, joined: false });
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
  ws.on('message', (data: Buffer) => {
    // Rate limiting
    if (!rateLimiter.allow(clientId)) {
      const msg = encodeMessage({
        type: 'error',
        payload: { code: ErrorCodes.RATE_LIMITED, message: 'Rate limited' },
      });
      ws.send(msg);
      return;
    }

    const message = decodeMessage(data);
    if (!message) {
      const msg = encodeMessage({
        type: 'error',
        payload: { code: ErrorCodes.INVALID_MESSAGE, message: 'Invalid message format' },
      });
      ws.send(msg);
      return;
    }

    const room = getOrCreateRoom(roomId);

    switch (message.type) {
      case 'join': {
        if (meta.joined) break; // Already joined
        const displayName = (message.payload.displayName || 'Anonymous').slice(0, 32);
        const success = room.join(clientId, ws, displayName);
        if (success) {
          meta.joined = true;
        }
        break;
      }

      case 'state': {
        if (!meta.joined) {
          const msg = encodeMessage({
            type: 'error',
            payload: { code: ErrorCodes.NOT_JOINED, message: 'Send a "join" message first' },
          });
          ws.send(msg);
          break;
        }
        room.updatePlayerState(clientId, message.payload);
        break;
      }

      case 'chat': {
        if (!meta.joined) break;
        room.chat(clientId, message.payload.message);
        break;
      }
    }
  });

  // ─── Disconnect ───────────────────────────────────────────
  ws.on('close', () => {
    clearInterval(pingInterval);
    rateLimiter.remove(clientId);
    const room = rooms.get(roomId);
    if (room) {
      room.leave(clientId);
      // Clean up empty rooms (except lobby)
      if (room.playerCount === 0 && roomId !== 'lobby') {
        room.destroy();
        rooms.delete(roomId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] Client ${clientId} error:`, err.message);
  });
});

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
  console.log(`[node-ws-gameserver] Config: ${SNAPSHOT_HZ}Hz tick, ${MAX_PLAYERS_PER_ROOM} max/room, ${MAX_MESSAGES_PER_SECOND} msg/s limit`);
});
