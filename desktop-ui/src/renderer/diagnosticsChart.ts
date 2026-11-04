export const DIAGNOSTICS_CHART_BOUNDS = { left: 48, right: 748, top: 24, bottom: 184 } as const;

interface Metric<Key extends string> {
  key: Key;
  label: string;
  unit: string;
  color: string;
  dash: string;
  divisor?: number;
}

export function normalizedDiagnosticsChart<Key extends string>(
  input: readonly ({ at: number; bootId?: string } & Record<Key, number>)[],
  metrics: readonly Metric<Key>[],
  intervalMs: number,
  maxGapMs = intervalMs,
) {
  const samples = [...input].sort((a, b) => a.at - b.at);
  const start = samples[0]?.at ?? 0;
  const end = Math.max(start + intervalMs, samples.at(-1)?.at ?? start);
  const { left, right, top, bottom } = DIAGNOSTICS_CHART_BOUNDS;
  return {
    start, end, hasData: samples.length > 0,
    series: metrics.map(metric => {
      const values = samples.map(sample => sample[metric.key] / (metric.divisor ?? 1));
      const peak = Math.max(0, ...values);
      const points = samples.map((sample, index) => {
        const value = values[index], normalized = peak === 0 ? 0 : value / peak * 100;
        return { at: sample.at, value, normalized,
          x: left + (sample.at - start) / (end - start) * (right - left),
          y: bottom - normalized / 100 * (bottom - top) };
      });
      return { ...metric, peak, points,
        path: points.map((point, index) =>
          `${index === 0 || point.at - points[index - 1].at > maxGapMs
            || samples[index].bootId !== samples[index - 1].bootId ? 'M' : 'L'}${point.x},${point.y}`).join(' ') };
    }),
  };
}
