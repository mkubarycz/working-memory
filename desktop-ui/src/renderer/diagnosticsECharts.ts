import { use, type ComposeOption } from 'echarts/core';
import { LineChart, BarChart, type LineSeriesOption, type BarSeriesOption } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, AriaComponent,
  type GridComponentOption, type TooltipComponentOption, type AriaComponentOption,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { DIAGNOSTICS_BUCKET_MS, type DiagnosticsChartData } from './diagnosticsChart';
export { init, connect, disconnect } from 'echarts/core';

use([LineChart, BarChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);
type ChartOption = ComposeOption<LineSeriesOption | BarSeriesOption | GridComponentOption | TooltipComponentOption | AriaComponentOption>;

export function diagnosticsChartOption(chart: DiagnosticsChartData, selected: string | null, stacked: boolean): ChartOption {
  const series = chart.series.filter(item => selected === null || item.key === selected);
  return {
    animation: false,
    aria: { enabled: true },
    grid: { left: 64, right: 24, top: 20, bottom: 40 },
    xAxis: {
      type: 'time', min: chart.start, max: chart.end, minInterval: DIAGNOSTICS_BUCKET_MS,
      containShape: false, boundaryGap: [0, 0],
      axisLabel: { hideOverlap: true, formatter: (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) },
    },
    yAxis: { type: 'value', min: 0, ...(stacked ? { minInterval: 1 } : { max: 100 }),
      axisLabel: { formatter: stacked ? '{value}' : '{value}%' } },
    tooltip: {
      trigger: 'axis', confine: true,
      formatter: params => {
        const lines: string[] = [];
        for (const item of Array.isArray(params) ? params : [params]) {
          if (!Array.isArray(item.value) || typeof item.value[0] !== 'number') continue;
          const at = item.value[0];
          const metric = series.find(series => series.key === item.seriesId);
          const point = metric?.points.find(point => point.at === at);
          if (!metric || !point || point.value === null) continue;
          if (!lines.length) lines.push(point.from === undefined || point.to === undefined
            ? new Date(point.at).toLocaleString()
            : `${new Date(point.from).toLocaleTimeString()} - ${new Date(point.to).toLocaleTimeString()}`);
          lines.push(`${metric.label}: ${point.value.toLocaleString()} ${metric.unit}`);
        }
        const element = document.createElement('div');
        element.style.whiteSpace = 'pre-wrap';
        element.textContent = lines.join('\n');
        return element;
      },
    },
    series: series.map(metric => ({
      id: metric.key, name: metric.label, type: stacked ? 'bar' : 'line',
      ...(stacked ? { stack: 'requests', barMaxWidth: 24 } : {
        connectNulls: false, symbolSize: 5, showSymbol: true,
        lineStyle: { type: metric.dash ? 'dashed' : 'solid' },
      }),
      itemStyle: { color: metric.color },
      data: metric.points.flatMap((point, index) => {
        const value = stacked ? point.value : point.normalized;
        const data = [point.at, value];
        return !stacked && point.breakBefore && index > 0 ? [[point.at, null], data] : [data];
      }),
    })),
  };
}
