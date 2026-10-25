import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

const wasAway = (state: AppStateStatus) => state === 'background' || state === 'inactive';

/**
 * Calls `onReturn` each time the app comes back to the foreground.
 *
 * Screen focus (useFocusEffect) is navigation inside the app; it does not fire
 * when someone switches to Instagram and back. While the app is away the OS
 * suspends it — timers stop and socket events are missed — so a reel that
 * finished meanwhile kept showing "still working" until the next poll, or for
 * good on screens that do not poll.
 */
export function useOnForeground(onReturn: () => void) {
  const callback = useRef(onReturn);
  useEffect(() => {
    callback.current = onReturn;
  }, [onReturn]);

  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (wasAway(last) && next === 'active') callback.current();
      last = next;
    });
    return () => sub.remove();
  }, []);
}
