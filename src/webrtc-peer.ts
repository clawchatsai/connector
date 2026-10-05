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
  /** Set when another gateway is the offerer (gateway sharing). */
  peer?: { shareId: string; requesterGatewayId: string };
}

/** Gateway sharing: a DataChannel to another gateway, with the DTLS fingerprints each side signs. */
export interface PeerChannelInfo {
  connectionId: string;
  role: 'owner' | 'requester';
  peer?: { shareId: string; requesterGatewayId: string };
  dtls: { local: string; remote: string };
}

/** sha-256 DTLS fingerprint from an SDP ("" when absent). */
function sdpFingerprint(sdp: string | undefined): string {
  const m = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/m.exec(String(sdp || ''));
  return m ? m[1].toUpperCase() : '';
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
  /** Gateway-sharing connections: never handed to the browser path, not counted as devices. */
  private peerInfo: Map<string, PeerChannelInfo> = new Map();

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

    if (offer.peer) this.peerInfo.set(connectionId, { connectionId, role: 'owner', peer: offer.peer, dtls: { local: '', remote: sdpFingerprint(sdp) } });

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
    const info = this.peerInfo.get(connectionId);
    if (info) info.dtls.local = sdpFingerprint(pc.localDescription?.sdp || answer.sdp);

    console.log(`[WebRTCPeerManager] Answer created for connection ${connectionId}`);

    return {
      connectionId,
      sdp: answer.sdp!,
      candidates: [],
    };
  }

  /**
   * Gateway sharing: open a connection to another gateway (this side offers). The DataChannel is
   * emitted as 'peer-datachannel' once open, after handleAnswer() has applied the other side's answer.
   */
  async createOffer(connectionId: string, iceServers: any[]): Promise<{ sdp: string; candidates: unknown[] }> {
    const normalized = (iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }]).flatMap((s: any) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.map((url: string) => ({ urls: url, ...(s.username && { username: s.username }), ...(s.credential && { credential: s.credential }) }));
    });
    const pc = new RTCPeerConnection({ iceServers: normalized } as any);
    this.peerConnections.set(connectionId, pc);
    pc.onicecandidate = (event: any) => {
      if (event.candidate) this.emit('ice-candidate-local', { connectionId, candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
    };
    const dc = (pc as any).createDataChannel('clawchats-peer');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.peerInfo.set(connectionId, { connectionId, role: 'requester', dtls: { local: sdpFingerprint(pc.localDescription?.sdp || offer.sdp), remote: '' } });
    dc.onopen = () => this._handleDataChannel(dc, connectionId);
    return { sdp: pc.localDescription?.sdp || offer.sdp!, candidates: [] };
  }

  /** Gateway sharing: the other gateway's answer to createOffer(). */
  async handleAnswer(connectionId: string, sdp: string, candidates: unknown[]): Promise<void> {
    const pc = this.peerConnections.get(connectionId);
    const info = this.peerInfo.get(connectionId);
    if (!pc || info?.role !== 'requester') return;
    info.dtls.remote = sdpFingerprint(sdp);
    await pc.setRemoteDescription(new RTCSessionDescription({ sdp, type: 'answer' } as any));
    for (const c of candidates || []) { try { await pc.addIceCandidate(new RTCIceCandidate(c as any)); } catch { /* ignore */ } }
  }

  /** Close a gateway-sharing connection (e.g. the share was revoked). */
  closePeer(connectionId: string): void {
    this.activeChannels.get(connectionId)?.close();
    try { this.peerConnections.get(connectionId)?.close(); } catch { /* gone */ }
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
    this.peerInfo.clear();
  }

  /** Browser connections (gateway-sharing links aren't devices). */
  get activeCount(): number {
    let n = 0;
    for (const id of this.activeChannels.keys()) if (!this.peerInfo.has(id)) n++;
    return n;
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

      const info = this.peerInfo.get(connectionId);
      this.peerInfo.delete(connectionId);
      this.emit(info ? 'peer-datachannel-closed' : 'datachannel-closed', connectionId);
    });

    const info = this.peerInfo.get(connectionId);
    if (info) this.emit('peer-datachannel', channel, info);
    else this.emit('datachannel', channel, connectionId);
  }
}
