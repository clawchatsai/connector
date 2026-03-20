/**
 * WebRTCPeerManager — manages incoming WebRTC connections from browsers.
 *
 * Uses node-datachannel (libdatachannel C++ bindings) for production-grade
 * SCTP/DTLS/WebRTC. The W3C polyfill layer provides standard browser-like APIs.
 *
 * Replaces werift (pure-JS WebRTC) which had unreliable SCTP message delivery
 * under real network conditions (silent message drops on rapid sends).
 */

import { EventEmitter } from 'node:events';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'node-datachannel/polyfill';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface IceOffer {
  connectionId: string;
  sdp: string;
  candidates: unknown[];
}

export interface IceServers {
  connectionId: string;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

export interface DataChannelLike {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClosed(handler: () => void): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function wrapDataChannel(dc: any): DataChannelLike {
  const messageHandlers: Array<(data: string) => void> = [];
  const closedHandlers: Array<() => void> = [];

  // W3C-standard event handlers
  dc.onmessage = (event: any) => {
    const str = typeof event.data === 'string'
      ? event.data
      : Buffer.isBuffer(event.data)
        ? event.data.toString('utf8')
        : String(event.data);
    for (const h of messageHandlers) h(str);
  };

  dc.onclose = () => {
    for (const h of closedHandlers) h();
  };

  return {
    send(data: string): void {
      try {
        dc.send(data);
      } catch (err) {
        console.error('[WebRTCPeerManager] DataChannel send error:', err);
      }
    },

    close(): void {
      try {
        dc.close();
      } catch {
        // Channel may already be closed
      }
    },

    onMessage(handler: (data: string) => void): void {
      messageHandlers.push(handler);
    },

    onClosed(handler: () => void): void {
      closedHandlers.push(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// WebRTCPeerManager
// ---------------------------------------------------------------------------

export class WebRTCPeerManager extends EventEmitter {
  private pendingIceServers: Map<string, any[]> = new Map();
  private peerConnections: Map<string, any> = new Map();
  private activeChannels: Map<string, DataChannelLike> = new Map();

  constructor() {
    super();
  }

  setIceServers(data: IceServers): void {
    console.log(
      `[WebRTCPeerManager] Storing ICE servers for connection ${data.connectionId}`,
    );
    this.pendingIceServers.set(data.connectionId, data.iceServers as any[]);
  }

  async handleOffer(
    offer: IceOffer,
  ): Promise<{ connectionId: string; sdp: string; candidates: unknown[] }> {
    const { connectionId, sdp, candidates } = offer;

    // ICE restart: existing PC — renegotiate on it, DataChannel stays open.
    const existingPc = this.peerConnections.get(connectionId);
    if (existingPc) {
      console.log(`[WebRTCPeerManager] ICE restart for connection ${connectionId}`);
      await existingPc.setRemoteDescription(new RTCSessionDescription({ sdp, type: 'offer' } as any));
      for (const rawCandidate of candidates) {
        try { await existingPc.addIceCandidate(new RTCIceCandidate(rawCandidate as any)); } catch { /* ignore */ }
      }
      const answer = await existingPc.createAnswer();
      await existingPc.setLocalDescription(answer);
      return { connectionId, sdp: answer.sdp!, candidates: [] };
    }

    console.log(`[WebRTCPeerManager] Handling ICE offer for connection ${connectionId}`);

    const iceServers: any[] = this.pendingIceServers.get(connectionId) ?? [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    this.pendingIceServers.delete(connectionId);

    // Normalize: ensure urls is always a string (not array) per entry
    const normalized = iceServers.flatMap((s: any) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.map((url: string) => ({
        urls: url,
        ...(s.username && { username: s.username }),
        ...(s.credential && { credential: s.credential }),
      }));
    });

    const pc = new RTCPeerConnection({ iceServers: normalized } as any);
    this.peerConnections.set(connectionId, pc);

    // W3C-standard ondatachannel
    pc.ondatachannel = (event: any) => {
      const channel = event.channel;
      this._handleDataChannel(channel, connectionId);
    };

    // Forward local ICE candidates to browser via signaling
    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        this.emit('ice-candidate-local', {
          connectionId,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    // Set remote description (browser's offer)
    await pc.setRemoteDescription(new RTCSessionDescription({ sdp, type: 'offer' } as any));

    // Add bundled trickle ICE candidates
    for (const rawCandidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(rawCandidate as any));
      } catch (err) {
        console.warn(
          `[WebRTCPeerManager] Failed to add ICE candidate for ${connectionId}:`,
          err,
        );
      }
    }

    // Create and set local answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    console.log(`[WebRTCPeerManager] Answer created for connection ${connectionId}`);

    return {
      connectionId,
      sdp: answer.sdp!,
      candidates: [],
    };
  }

  handleIceCandidate(connectionId: string, candidate: unknown): void {
    const pc = this.peerConnections.get(connectionId);
    if (!pc) {
      console.warn(
        `[WebRTCPeerManager] handleIceCandidate: no peer connection for ${connectionId}`,
      );
      return;
    }

    pc.addIceCandidate(new RTCIceCandidate(candidate as any)).catch((err: Error) => {
      console.warn(
        `[WebRTCPeerManager] Failed to add trickle ICE candidate for ${connectionId}:`,
        err,
      );
    });
  }

  closeAll(): void {
    console.log(
      `[WebRTCPeerManager] Closing all connections (${this.peerConnections.size} peers, ${this.activeChannels.size} channels)`,
    );

    for (const [, channel] of this.activeChannels) {
      try { channel.close(); } catch { /* already closed */ }
    }
    this.activeChannels.clear();

    for (const [, pc] of this.peerConnections) {
      try { pc.close(); } catch { /* already closed */ }
    }
    this.peerConnections.clear();
    this.pendingIceServers.clear();
  }

  get activeCount(): number {
    return this.activeChannels.size;
  }

  private _handleDataChannel(dc: any, connectionId: string): void {
    console.log(`[WebRTCPeerManager] DataChannel opened for connection ${connectionId}`);

    const channel = wrapDataChannel(dc);
    this.activeChannels.set(connectionId, channel);

    channel.onClosed(() => {
      console.log(
        `[WebRTCPeerManager] DataChannel closed for connection ${connectionId}`,
      );
      this.activeChannels.delete(connectionId);

      const pc = this.peerConnections.get(connectionId);
      if (pc) {
        try { pc.close(); } catch { /* already closed */ }
        this.peerConnections.delete(connectionId);
      }

      this.emit('datachannel-closed', connectionId);
    });

    this.emit('datachannel', channel, connectionId);
  }
}
