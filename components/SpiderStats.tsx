import React from 'react';

export type SpiderStatMetric = {
  label: string;
  value: string | number;
  statsText?: string;
  score: number;
  outerPoint?: boolean;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
  color?: string;
  problems?: number;
  corrected?: number;
};

const clampScore = (score: number): number => Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
const METRIC_COLORS = ['#10b981', '#2563eb', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16', '#ec4899'];

const toneClass = (tone: SpiderStatMetric['tone']) => {
  switch (tone) {
    case 'good':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'warn':
      return 'text-amber-600 dark:text-amber-400';
    case 'bad':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-[#d4af37] dark:text-[#f2d675]';
  }
};

const getPoint = (index: number, total: number, radius: number, center: number, score = 100) => {
  const angle = (-Math.PI / 2) + (index * 2 * Math.PI) / total;
  const distance = radius * (clampScore(score) / 100);
  return {
    x: center + Math.cos(angle) * distance,
    y: center + Math.sin(angle) * distance,
  };
};

const pointsToString = (points: { x: number; y: number }[]) =>
  points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');

const getMetricColor = (metric: SpiderStatMetric, index: number) => metric.color || METRIC_COLORS[index % METRIC_COLORS.length];
const getMetricStatsText = (metric: SpiderStatMetric): string => {
  if (metric.statsText) return metric.statsText;
  if (typeof metric.problems === 'number' || typeof metric.corrected === 'number') {
    return `${metric.problems ?? 0}/${metric.corrected ?? 0}`;
  }
  return String(metric.value);
};

const SpiderStats: React.FC<{ metrics: SpiderStatMetric[]; title?: string; compact?: boolean }> = ({ metrics, title, compact = false }) => {
  const visibleMetrics = metrics.filter(Boolean);
  if (visibleMetrics.length < 3) return null;

  const size = compact ? 176 : 220;
  const center = size / 2;
  const radius = compact ? 76 : 96;
  const gridLevels = [0.33, 0.66, 1];
  const outerPoints = visibleMetrics.map((_, index) => getPoint(index, visibleMetrics.length, radius, center));
  const dataPoints = visibleMetrics.map((metric, index) => getPoint(index, visibleMetrics.length, radius, center, metric.score));

  return (
    <div className="group relative rounded-xl border border-gray-200 bg-white p-2 shadow-sm dark:border-[#3C3C3C] dark:bg-gradient-to-r dark:from-[#2A2A2A] dark:via-[#222222] dark:to-[#1F1F1F]">
      {title && (
        <div className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </div>
      )}
      <div className="flex flex-col items-center gap-2">
        <svg width="100%" height={size} viewBox={`0 0 ${size} ${size}`} className="block overflow-visible">
          {gridLevels.map(level => (
            <polygon
              key={level}
              points={pointsToString(visibleMetrics.map((_, index) => getPoint(index, visibleMetrics.length, radius * level, center)))}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-gray-200 dark:text-[#3C3C3C]"
            />
          ))}
          {outerPoints.map((point, index) => (
            <line
              key={`spoke-${index}`}
              x1={center}
              y1={center}
              x2={point.x}
              y2={point.y}
              stroke="currentColor"
              strokeWidth="1"
              className="text-gray-200 dark:text-[#3C3C3C]"
            />
          ))}
          <polygon
            points={pointsToString(dataPoints)}
            fill="rgba(212, 175, 55, 0.22)"
            stroke="#d4af37"
            strokeWidth="2"
          />
          {dataPoints.map((point, index) => (
            <g key={`data-${visibleMetrics[index].label}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={compact ? 5.5 : 6.5}
                fill={getMetricColor(visibleMetrics[index], index)}
                stroke="white"
                strokeWidth="2"
              />
              <title>{`${visibleMetrics[index].label}: ${visibleMetrics[index].value}`}</title>
            </g>
          ))}
          {visibleMetrics.map((metric, index) => {
            if (!metric.outerPoint) return null;
            const point = outerPoints[index];
            return (
              <circle
                key={`outer-${metric.label}`}
                cx={point.x}
                cy={point.y}
                r={compact ? 4.5 : 5}
                fill={getMetricColor(metric, index)}
                stroke="white"
                strokeWidth="2"
              />
            );
          })}
        </svg>
        <div className="grid w-full grid-cols-2 gap-x-2 gap-y-1">
          {visibleMetrics.map((metric, index) => (
            <div key={metric.label} title={`${metric.label}: ${metric.value}`} className="flex min-w-0 items-center gap-1.5">
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: getMetricColor(metric, index) }} />
              <span className="truncate text-[10px] font-bold text-gray-500 dark:text-gray-400">{metric.label}</span>
              <span className="ms-auto flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-black text-gray-700 dark:bg-[#1F1F1F] dark:text-gray-200">
                {getMetricStatsText(metric)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SpiderStats;
