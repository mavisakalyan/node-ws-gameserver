import { WebSocket } from 'ws';
import { encodeMessage, PROTOCOL_VERSION, type ServerMessage, ErrorCodes } from './protocol.js';

export interface Peer {
  id: string;
  ws: WebSocket;
  joinedAt: number;
}

export class Room {
  readonly id: string;
  private peers: Map<string, Peer> = new Map();
  private readonly maxPlayers: number;

  // Metrics
  private messageCount = 0;
  private lastMessageCountReset = Date.now();
  messagesPerSecond = 0;

  constructor(id: string, maxPlayers: number) {
    this.id = id;
    this.maxPlayers = maxPlayers;
  }

  get playerCount(): number {
    return this.peers.size;
  }

  get isFull(): boolean {
    return this.peers.size >= this.maxPlayers;
  }

  /**
   * Add a peer to the room. Auto-called on WebSocket open.
   * Returns false if room is full.
   */
  join(id: string, ws: WebSocket): boolean {
    if (this.isFull) {
      const msg = encodeMessage({
        type: 'error',
        code: ErrorCodes.ROOM_FULL,
        message: `Room "${this.id}" is full (${this.maxPlayers} peers)`,
      });
      ws.send(msg);
      return false;
    }

    // Collect existing peer IDs before adding the new one
    const existingPeerIds: string[] = [];
    for (const peer of this.peers.values()) {
      existingPeerIds.push(peer.id);
    }

    const peer: Peer = {
      id,
      ws,
      joinedAt: Date.now(),
    };

    this.peers.set(id, peer);

    // Send welcome to the new peer with list of existing peers
    this.send(ws, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      playerId: id,
      peers: existingPeerIds,
    });

    // Notify existing peers
    this.broadcast({
      type: 'peer_joined',
      peerId: id,
    }, id);

    return true;
  }

  /**
   * Remove a peer from the room.
   */
  leave(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;

    this.peers.delete(id);

    // Notify remaining peers
    this.broadcast({
      type: 'peer_left',
      peerId: id,
    });
  }

  /**
   * Relay a client message to all other peers in the room.
   * The original message is wrapped in a `relay` envelope.
   */
  relay(fromId: string, data: unknown): void {
    const peer = this.peers.get(fromId);
    if (!peer) return;

    this.broadcast({
      type: 'relay',
      from: fromId,
      data,
    }, fromId);

    this.messageCount++;
  }

  /** Check if a peer exists in this room */
  hasPeer(id: string): boolean {
    return this.peers.has(id);
  }

  /** Send a message to a single WebSocket */
  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(msg));
    }
  }

  /** Broadcast a message to all peers (optionally excluding one) */
  private broadcast(msg: ServerMessage, excludeId?: string): void {
    const data = encodeMessage(msg);
    for (const [id, peer] of this.peers) {
      if (id === excludeId) continue;
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(data);
      }
    }
  }

  /** Update messages/sec metric (call periodically) */
  updateMetrics(): void {
    const now = Date.now();
    const elapsed = now - this.lastMessageCountReset;
    if (elapsed >= 1000) {
      this.messagesPerSecond = Math.round((this.messageCount / elapsed) * 1000);
      this.messageCount = 0;
      this.lastMessageCountReset = now;
    }
  }

  /** Clean up the room */
  destroy(): void {
    for (const peer of this.peers.values()) {
      peer.ws.close(1001, 'Room destroyed');
    }
    this.peers.clear();
  }
}
