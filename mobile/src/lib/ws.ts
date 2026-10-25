import { AppState } from 'react-native';
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

  /*
   * A socket left behind while the app was suspended can be half-open: it still
   * reads as OPEN but nothing will ever arrive on it, and onclose never fires to
   * reconnect it. So coming back always means a fresh socket, at once.
   */
  let last = AppState.currentState;
  const appState = AppState.addEventListener('change', (next) => {
    if ((last === 'background' || last === 'inactive') && next === 'active' && !closed) {
      if (timer) clearTimeout(timer);
      const stale = socket;
      socket = undefined;
      if (stale) {
        stale.onclose = null;
        stale.onerror = null;
        stale.onmessage = null;
        stale.close();
      }
      attempt = 0;
      void connect();
    }
    last = next;
  });

  return () => {
    closed = true;
    appState.remove();
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
