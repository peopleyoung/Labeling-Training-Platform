import { useMemo, useState, type PointerEvent } from 'react';

export interface MetricSeries {
  name: string;
  color: string;
  values: number[];
  axis?: 'left' | 'right';
  format?: 'score' | 'number';
}

interface Scale {
  minimum: number;
  maximum: number;
  ticks: number[];
}

function niceStep(range: number, tickCount: number) {
  const rough = Math.max(range, Number.EPSILON) / Math.max(1, tickCount - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function scaleFor(values: number[], scoreScale: boolean): Scale {
  if (scoreScale) return { minimum: 0, maximum: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (!values.length) return { minimum: 0, maximum: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const padding = rawMinimum === rawMaximum ? Math.max(Math.abs(rawMinimum) * 0.1, 0.1) : (rawMaximum - rawMinimum) * 0.05;
  const step = niceStep(rawMaximum - rawMinimum + padding * 2, 5);
  const minimum = Math.floor((rawMinimum - padding) / step) * step;
  const maximum = Math.ceil((rawMaximum + padding) / step) * step;
  const ticks = Array.from({ length: Math.round((maximum - minimum) / step) + 1 }, (_, index) => minimum + index * step);
  return { minimum, maximum: maximum === minimum ? minimum + 1 : maximum, ticks: ticks.slice(0, 7) };
}

function formatValue(value: number | undefined, format: MetricSeries['format'] = 'number') {
  if (value === undefined || !Number.isFinite(value)) return '--';
  if (format === 'score') return `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 1) return value.toFixed(3);
  return value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

export function MetricChart({ series, labels, height = 240 }: { series: MetricSeries[]; labels: string[]; height?: number }) {
  const width = 760;
  const padding = { top: 22, right: 66, bottom: 34, left: 66 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const visibleSeries = series.filter((item) => !hiddenSeries.includes(item.name));
  const leftSeries = visibleSeries.filter((item) => (item.axis ?? 'left') === 'left');
  const rightSeries = visibleSeries.filter((item) => item.axis === 'right');
  const leftScale = useMemo(() => scaleFor(leftSeries.flatMap((item) => item.values), leftSeries.some((item) => item.format === 'score')), [leftSeries]);
  const rightScale = useMemo(() => scaleFor(rightSeries.flatMap((item) => item.values), false), [rightSeries]);
  const point = (value: number, index: number, count: number, axis: MetricSeries['axis'] = 'left') => {
    const scale = axis === 'right' ? rightScale : leftScale;
    return {
      x: padding.left + (index / Math.max(1, count - 1)) * innerWidth,
      y: padding.top + innerHeight - ((value - scale.minimum) / (scale.maximum - scale.minimum || 1)) * innerHeight,
    };
  };
  const pointerIndex = (event: PointerEvent<SVGRectElement>) => {
    if (!labels.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewX = (event.clientX - bounds.left) / Math.max(1, bounds.width) * width;
    setHoveredIndex(Math.max(0, Math.min(labels.length - 1, Math.round((viewX - padding.left) / innerWidth * Math.max(1, labels.length - 1)))));
  };
  const tooltipX = hoveredIndex === null ? 0 : point(0, hoveredIndex, labels.length).x;
  const tooltipWidth = 176;
  const tooltipLeft = Math.min(width - padding.right - tooltipWidth, Math.max(padding.left, tooltipX + 10));

  return (
    <div className="metric-chart">
      <div className="chart-legend" aria-label="指标系列">
        {series.map((item) => {
          const hidden = hiddenSeries.includes(item.name);
          const latest = item.values.at(-1);
          return <button type="button" className={hidden ? 'is-hidden' : ''} key={item.name} aria-pressed={!hidden} onClick={() => setHiddenSeries((current) => hidden ? current.filter((name) => name !== item.name) : [...current, item.name])}><i style={{ background: item.color }} /><span>{item.name}</span><b>{latest === undefined ? '--' : formatValue(latest, item.format)}</b></button>;
        })}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="训练指标曲线">
        {leftScale.ticks.map((tick) => {
          const y = point(tick, 0, 1, 'left').y;
          return <g key={`left-${tick}`}><line x1={padding.left} y1={y} x2={width - padding.right} y2={y} className="chart-grid" /><text x={padding.left - 9} y={y + 3} textAnchor="end" className="chart-label chart-y-label">{formatValue(tick, leftSeries.some((item) => item.format === 'score') ? 'score' : 'number')}</text></g>;
        })}
        {rightSeries.length > 0 && rightScale.ticks.map((tick) => {
          const y = point(tick, 0, 1, 'right').y;
          return <text key={`right-${tick}`} x={width - padding.right + 9} y={y + 3} textAnchor="start" className="chart-label chart-y-label">{formatValue(tick)}</text>;
        })}
        {labels.map((label, index) => {
          const interval = Math.max(1, Math.ceil(labels.length / 6));
          if (index % interval !== 0 && index !== labels.length - 1) return null;
          const { x } = point(0, index, labels.length);
          return <text key={`${label}-${index}`} x={x} y={height - 9} textAnchor="middle" className="chart-label">{label}</text>;
        })}
        {visibleSeries.map((item) => {
          const points = item.values.map((value, index) => point(value, index, item.values.length, item.axis));
          const path = points.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
          return <g key={item.name}><path d={path} fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />{points.map(({ x, y }, index) => <circle key={index} cx={x} cy={y} r={hoveredIndex === index ? 4 : 2.6} fill={item.color} stroke="white" strokeWidth="1.3" />)}</g>;
        })}
        {hoveredIndex !== null && visibleSeries.length > 0 && <g className="chart-tooltip"><line x1={tooltipX} y1={padding.top} x2={tooltipX} y2={padding.top + innerHeight} className="chart-crosshair" /><rect x={tooltipLeft} y={padding.top + 5} width={tooltipWidth} height={26 + visibleSeries.length * 18} rx="4" /><text x={tooltipLeft + 10} y={padding.top + 22} className="chart-tooltip-title">{labels[hoveredIndex]}</text>{visibleSeries.map((item, index) => <g key={item.name}><circle cx={tooltipLeft + 12} cy={padding.top + 39 + index * 18} r="3" fill={item.color} /><text x={tooltipLeft + 21} y={padding.top + 42 + index * 18}>{item.name}</text><text x={tooltipLeft + tooltipWidth - 10} y={padding.top + 42 + index * 18} textAnchor="end">{formatValue(item.values[hoveredIndex], item.format)}</text></g>)}</g>}
        <rect x={padding.left} y={padding.top} width={innerWidth} height={innerHeight} fill="transparent" className="chart-pointer-layer" onPointerMove={pointerIndex} onPointerLeave={() => setHoveredIndex(null)} onPointerDown={pointerIndex} />
      </svg>
    </div>
  );
}
