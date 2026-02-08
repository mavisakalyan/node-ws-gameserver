import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Room } from './room.js';

export interface HealthInfo {
  status: 'ok';
  uptime: number;
  rooms: number;
  connections: number;
  timestamp: string;
}

export interface MetricsInfo {
  uptime: number;
  rooms: Record<string, { players: number; messagesPerSecond: number }>;
  totalConnections: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

const startTime = Date.now();

/**
 * Handle HTTP requests for /health and /metrics.
 * Returns true if the request was handled, false otherwise.
 */
export function handleHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rooms: Map<string, Room>,
): boolean {
  const url = req.url;

  if (url === '/health') {
    let totalConnections = 0;
    for (const room of rooms.values()) {
      totalConnections += room.playerCount;
    }

    const health: HealthInfo = {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      rooms: rooms.size,
      connections: totalConnections,
      timestamp: new Date().toISOString(),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return true;
  }

  if (url === '/metrics') {
    let totalConnections = 0;
    const roomMetrics: MetricsInfo['rooms'] = {};

    for (const [id, room] of rooms) {
      totalConnections += room.playerCount;
      roomMetrics[id] = {
        players: room.playerCount,
        messagesPerSecond: room.messagesPerSecond,
      };
    }

    const mem = process.memoryUsage();
    const metrics: MetricsInfo = {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      rooms: roomMetrics,
      totalConnections,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
    return true;
  }

  return false;
}
