import { getIdToken } from './auth';
import type { Media } from './api';
import { WS_URL } from './config';

export type MediaEvent = { type: 'media'; media: Media };

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribes to pipeline progress, the same channel the web uses. The server
 * fans each change out only to people who have saved that reel.
 *
 * The id token goes in the query string because a WebSocket handshake cannot
 * carry an authorization header. Reconnects with backoff until unsubscribed.
 */
export function subscribeToMedia(onEvent: (event: MediaEvent) => void): () => void {
  if (!WS_URL) return () => {};

  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  async function connect() {
    if (closed) return;
    try {
      const token = await getIdToken();
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as MediaEvent;
          if (parsed.type === 'media') onEvent(parsed);
        } catch {
          // A frame we cannot parse is not worth tearing the socket down for.
        }
      };
      socket.onclose = () => scheduleReconnect();
      socket.onerror = () => socket?.close();
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt++, RECONNECT_MAX_MS);
    timer = setTimeout(() => void connect(), delay);
  }

  void connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
