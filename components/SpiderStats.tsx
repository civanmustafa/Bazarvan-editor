import React from 'react';

export type SpiderStatMetric = {
  label: string;
  value: string | number;
  score: number;
  outerPoint?: boolean;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
};

const clampScore = (score: number): number => Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));

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

const SpiderStats: React.FC<{ metrics: SpiderStatMetric[]; title?: string; compact?: boolean }> = ({ metrics, title, compact = false }) => {
  const visibleMetrics = metrics.filter(Boolean);
  if (visibleMetrics.length < 3) return null;

  const size = compact ? 136 : 164;
  const center = size / 2;
  const radius = compact ? 48 : 58;
  const gridLevels = [0.33, 0.66, 1];
  const outerPoints = visibleMetrics.map((_, index) => getPoint(index, visibleMetrics.length, radius, center));
  const dataPoints = visibleMetrics.map((metric, index) => getPoint(index, visibleMetrics.length, radius, center, metric.score));

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-gradient-to-r dark:from-[#2A2A2A] dark:via-[#222222] dark:to-[#1F1F1F]">
      {title && (
        <div className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </div>
      )}
      <div className="flex flex-col items-center gap-3">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
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
            <circle
              key={`data-${visibleMetrics[index].label}`}
              cx={point.x}
              cy={point.y}
              r={compact ? 3 : 3.5}
              fill="#d4af37"
              stroke="white"
              strokeWidth="1.5"
            />
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
                fill="#10b981"
                stroke="white"
                strokeWidth="2"
              />
            );
          })}
        </svg>
        <div className="grid w-full grid-cols-2 gap-2">
          {visibleMetrics.map(metric => (
            <div key={metric.label} title={metric.label} className="min-w-0 rounded-lg bg-gray-50 px-2 py-1.5 dark:bg-[#1F1F1F]">
              <div className="truncate text-[10px] font-bold text-gray-500 dark:text-gray-400">{metric.label}</div>
              <div className={`truncate text-sm font-black ${toneClass(metric.tone)}`}>{metric.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SpiderStats;
