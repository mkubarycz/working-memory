import type { HeapCollection, SessionSnapshot } from '../../../control-plane/src/sessionPolicy';
import type { HeapRecoveryResult } from '../shared/instanceIdentity';

export async function recoverHeap(options: {
  snapshot: () => Promise<SessionSnapshot>;
  ensureCurrent: () => void;
  confirm: (snapshot: SessionSnapshot) => Promise<boolean>;
  saveReport: (snapshot: SessionSnapshot) => Promise<string>;
  collect: (snapshot: SessionSnapshot, topicId: string) => Promise<{ collection: HeapCollection; snapshot: SessionSnapshot }>;
}): Promise<HeapRecoveryResult> {
  options.ensureCurrent();
  const snapshot = await options.snapshot();
  options.ensureCurrent();
  if (!snapshot.memory.gcAvailable) throw new Error('Manual garbage collection is unavailable. Upgrade/start this backend with --expose-gc.');
  if (!await options.confirm(snapshot)) return { status: 'cancelled' };
  options.ensureCurrent();
  const topicId = await options.saveReport(snapshot);
  options.ensureCurrent();
  try {
    const result = await options.collect(snapshot, topicId);
    options.ensureCurrent();
    return { status: 'collected', topicId, ...result };
  } catch (error) {
    console.error('[heap-recovery] Report saved but heap collection failed:', error);
    return { status: 'failed', topicId, error: error instanceof Error ? error.message : String(error) };
  }
}
