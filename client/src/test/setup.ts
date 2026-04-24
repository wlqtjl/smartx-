/**
 * Vitest global setup: polyfill things the client code touches when running
 * under jsdom. Keep minimal — only what tests actually hit.
 */
import { afterEach, vi } from 'vitest';

// Silence noisy console.warn/error from intentionally-erroring code paths
// unless tests opt in by spying themselves.
afterEach(() => {
  vi.restoreAllMocks();
});
