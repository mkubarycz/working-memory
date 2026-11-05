export interface DiagnosticsChartPoint {
  at: number;
  value: number | null;
  normalized: number | null;
  breakBefore: boolean;
  from?: number;
  to?: number;
}

export interface DiagnosticsChartSeries {
  key: string;
  label: string;
  unit: string;
  color: string;
  dash: string;
  peak: number;
  points: DiagnosticsChartPoint[];
}

export interface DiagnosticsChartData {
  start: number;
  end: number;
  hasData: boolean;
  series: DiagnosticsChartSeries[];
}

interface Metric<Key extends string> {
  key: Key;
  label: string;
  unit: string;
  color: string;
  dash: string;
  divisor?: number;
  aggregation?: 'average' | 'max' | 'sum';
}

export const DIAGNOSTICS_BUCKET_MS = 60000;

export function normalizedDiagnosticsChart<Key extends string>(
  input: readonly ({ at: number; bootId?: string } & Record<Key, number | undefined>)[],
  metrics: readonly Metric<Key>[],
  maxGapMs = DIAGNOSTICS_BUCKET_MS,
): DiagnosticsChartData {
  const samples = [...input].sort((a, b) => a.at - b.at);
  const buckets = new Map<number, typeof samples>();
  for (const sample of samples) {
    const at = Math.floor(sample.at / DIAGNOSTICS_BUCKET_MS) * DIAGNOSTICS_BUCKET_MS;
    const bucket = buckets.get(at) ?? [];
    bucket.push(sample);
    buckets.set(at, bucket);
  }
  const entries = [...buckets];
  const start = entries[0]?.[0] ?? 0;
  const end = (entries.at(-1)?.[0] ?? start) + DIAGNOSTICS_BUCKET_MS;
  return {
    start, end, hasData: samples.length > 0,
    series: metrics.map(metric => {
      const points: DiagnosticsChartPoint[] = entries.map(([from, bucket], index) => {
        const values = bucket.flatMap(sample => {
          const value = sample[metric.key];
          return value === undefined ? [] : [value / (metric.divisor ?? 1)];
        });
        const previousBucket = entries[index - 1]?.[1];
        const previous = previousBucket?.at(-1);
        const first = bucket[0];
        const value = !values.length ? null : metric.aggregation === 'max' ? Math.max(...values)
          : values.reduce((total, value) => total + value, 0) / (metric.aggregation === 'sum' ? 1 : values.length);
        return {
          at: from + DIAGNOSTICS_BUCKET_MS / 2, from, to: from + DIAGNOSTICS_BUCKET_MS,
          value, normalized: null,
          breakBefore: !previous || previous[metric.key] === undefined || previous.bootId !== first.bootId
            || first.at - previous.at > maxGapMs
            || !!previousBucket?.some(sample => sample.bootId !== first.bootId || sample[metric.key] === undefined)
            || bucket.some((sample, i) => sample[metric.key] === undefined
              || (i > 0 && (sample.bootId !== bucket[i - 1].bootId || sample.at - bucket[i - 1].at > maxGapMs))),
        };
      });
      const peak = Math.max(0, ...points.map(point => point.value ?? 0));
      for (const point of points) {
        point.normalized = point.value === null ? null : peak === 0 ? 0 : point.value / peak * 100;
      }
      return { ...metric, peak, points };
    }),
  };
}
