import { useRef } from 'react';

// Module-level monotonic counter — each mounted modal gets a strictly higher
// z-index than any modal that was alive when it mounted, so nested modals
// always render above their parents. Never decrements (avoids collisions when
// modals close out of order).

let counter = 0;
const BASE = 1000;
const STEP = 10;

export function useModalZIndex() {
  const z = useRef(null);
  if (z.current === null) {
    counter += 1;
    z.current = BASE + counter * STEP;
  }
  return z.current;
}
