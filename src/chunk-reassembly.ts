/**
 * chunk-reassembly.ts — reassembly of chunked browser messages (rpc-chunk-req, gateway-msg-chunk)
 *
 * The browser splits messages over the DataChannel size limit into chunks
 * { id, index, total, data }. Every field is checked and memory is bounded: per message,
 * across all messages, and in time (a message not complete within 30 s is dropped).
 */

/** One chunk's data: at most one DataChannel message. */
export const MAX_CHUNK_DATA_LENGTH = 64 * 1024;
/** One reassembled message (string length; uploads arrive base64-encoded). */
export const MAX_MESSAGE_LENGTH = 128 * 1024 * 1024;
/** All messages being reassembled at once. */
export const MAX_BUFFERED_LENGTH = 256 * 1024 * 1024;
export const MAX_CHUNKS = 4096;
const MAX_MESSAGES = 64;
const MAX_ID_LENGTH = 256;
const TTL_MS = 30_000;

interface PartialMessage { connectionId: string; chunks: string[]; received: number; total: number; length: number; timer: ReturnType<typeof setTimeout> }

export type ChunkResult = { done: string } | { error: string } | null;

export class ChunkReassembler {
  private readonly bufs = new Map<string, PartialMessage>();
  private buffered = 0;

  constructor(private readonly limits = { message: MAX_MESSAGE_LENGTH, buffered: MAX_BUFFERED_LENGTH }) {}

  /**
   * Add one chunk from a connection. Returns the whole message once every chunk is in,
   * an error for an invalid chunk (that message is dropped), or null while waiting.
   */
  add(connectionId: string, msg: Record<string, unknown>): ChunkResult {
    const { id, index, total, data } = msg;
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) return { error: 'bad id' };
    if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > MAX_CHUNKS) return { error: 'bad total' };
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= (total as number)) return { error: 'bad index' };
    if (typeof data !== 'string' || !data || data.length > MAX_CHUNK_DATA_LENGTH) return { error: 'bad data' };

    const key = `${connectionId}\0${id}`;
    let buf = this.bufs.get(key);
    if (!buf) {
      if (this.bufs.size >= MAX_MESSAGES) return { error: 'too many chunked messages in progress' };
      const timer = setTimeout(() => this.drop(key), TTL_MS);
      timer.unref?.();
      buf = { connectionId, chunks: new Array(total as number), received: 0, total: total as number, length: 0, timer };
      this.bufs.set(key, buf);
    }
    if (buf.total !== total) { this.drop(key); return { error: 'total changed' }; }
    if (buf.chunks[index as number] !== undefined) return null; // duplicate: keep the first

    if (buf.length + data.length > this.limits.message) { this.drop(key); return { error: 'message too large' }; }
    if (this.buffered + data.length > this.limits.buffered) { this.drop(key); return { error: 'too much data in progress' }; }
    buf.chunks[index as number] = data;
    buf.received++;
    buf.length += data.length;
    this.buffered += data.length;

    if (buf.received < buf.total) return null;
    this.drop(key);
    return { done: buf.chunks.join('') };
  }

  /** Forget a closed connection's partial messages. */
  dropConnection(connectionId: string): void {
    for (const [key, buf] of this.bufs) if (buf.connectionId === connectionId) this.drop(key);
  }

  /** Characters held in partial messages (tests). */
  get bufferedLength(): number { return this.buffered; }

  private drop(key: string): void {
    const buf = this.bufs.get(key);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.buffered -= buf.length;
    this.bufs.delete(key);
  }
}
