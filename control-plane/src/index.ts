/**
 * Entry point for the Working Memory control-plane daemon.
 *
 * Run directly: `node out/control-plane/index.js` (see the "Run Control Plane
 * Service" launch config for the F5 flow).
 */

import { runDaemon } from './daemon.js';
import { AlreadyRunningError } from './lockfile.js';

runDaemon().catch((err: unknown) => {
  if (err instanceof AlreadyRunningError) {
    // eslint-disable-next-line no-console
    console.error(`[control-plane] ${err.message}`);
    process.exit(3);
  }
  // eslint-disable-next-line no-console
  console.error('[control-plane] failed to start:', err);
  process.exit(1);
});
