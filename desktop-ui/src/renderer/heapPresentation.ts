import type { SessionSnapshot } from '../../../control-plane/src/sessionPolicy';

export function heapPressure(memory: SessionSnapshot['memory']): { severity: 'normal' | 'warning' | 'critical'; label: string; percent: number } {
  const percent = memory.heapLimitBytes > 0 ? memory.heapUsedBytes / memory.heapLimitBytes * 100 : 0;
  return { percent,
    severity: memory.admissionBlocked || percent >= 60 ? 'critical' : percent >= 50 ? 'warning' : 'normal',
    label: memory.admissionBlocked || percent >= 60 ? 'High - session admission paused' : percent >= 50 ? 'Approaching safety cutoff' : 'Within safety range' };
}

export function heapCategories(memory: SessionSnapshot['memory']): { label: string; bytes: number; color: string; percent: number }[] {
  const labels: Record<string, { label: string; color: string }> = {
    old_space: { label: 'Long-lived objects (old space)', color: '#528bff' },
    new_space: { label: 'Young objects (new space)', color: '#36a875' },
    large_object_space: { label: 'Large objects', color: '#ba76d1' },
    new_large_object_space: { label: 'Young large objects', color: '#74b97c' },
    code_space: { label: 'Compiled JavaScript', color: '#d09a42' },
    code_large_object_space: { label: 'Large compiled code', color: '#e5b65f' },
    trusted_space: { label: 'V8 trusted objects', color: '#b47f68' },
    trusted_large_object_space: { label: 'Large V8 trusted objects', color: '#c59d8d' },
  };
  const spaces = (memory.spaces ?? []).filter(space => space.usedBytes > 0);
  const total = spaces.reduce((sum, space) => sum + space.usedBytes, 0);
  return spaces.map(space => ({
    label: labels[space.name]?.label ?? space.name.replaceAll('_', ' '),
    color: labels[space.name]?.color ?? '#8b8b8b', bytes: space.usedBytes,
    percent: total > 0 ? space.usedBytes / total * 100 : 0,
  })).sort((a, b) => b.bytes - a.bytes);
}
