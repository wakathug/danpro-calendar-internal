import { performance } from 'node:perf_hooks';

const METRIC_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

export function startTimer() {
  return performance.now();
}

export function elapsedMs(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

export function safeMetrics(metrics) {
  const safe = {};
  for (const [name, value] of Object.entries(metrics || {})) {
    if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value) || value < 0) continue;
    safe[name] = Math.round(value * 10) / 10;
  }
  return safe;
}

export function serverTiming(metrics) {
  return Object.entries(safeMetrics(metrics))
    .map(([name, value]) => `${name};dur=${value.toFixed(1)}`)
    .join(', ');
}

export function logPerformance(route, status, metrics) {
  console.info(JSON.stringify({
    event: 'performance_timing',
    route,
    status,
    ...safeMetrics(metrics),
  }));
}
