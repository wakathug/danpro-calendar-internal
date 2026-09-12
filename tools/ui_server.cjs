'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const symbols = ['◎', '○', '△', '×'];
const labels = ['余裕あり', '対応可能', 'やや混雑', '混雑'];
const counts = [0, 1, 2, 3, 4, 5, 6, 7];
const weekendCounts = new Map([
  [5, 0],
  [6, 0],
  [12, 1],
  [13, 3],
  [19, 5],
  [20, 2],
  [26, 4],
  [27, 6],
]);

const days = Array.from({ length: 30 }, (_, index) => {
  const day = index + 1;
  const count = weekendCounts.get(day) ?? counts[index % counts.length];
  const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : 3;
  return {
    date: `2026-09-${String(day).padStart(2, '0')}`,
    count,
    level,
    symbol: symbols[level],
  };
});

const fixture = {
  ok: true,
  data: {
    days,
    levels: symbols.map((symbol, level) => ({ level, symbol, label: labels[level] })),
    updatedAt: '2026-09-10T03:34:56.000Z',
    timeZone: 'Asia/Tokyo',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/local-preview/edit?gid=123',
  },
};

const detail = {
  ok: true,
  data: {
    date: '2026-09-01',
    items: [
      { customer: 'サンプル顧客', content: 'パッケージ', work: 'デザイン', period: '午前' },
      { customer: 'テスト案件', content: 'カタログ', work: '印刷', period: '午後' },
    ],
  },
};

const stub = `<script>
  (() => {
    const calendarFixture = ${JSON.stringify(fixture)};
    const detailFixture = ${JSON.stringify(detail)};
    class Runner {
      withSuccessHandler(handler) { this.success = handler; return this; }
      withFailureHandler(handler) { this.failure = handler; return this; }
      getCalendarData() { this.success(calendarFixture); }
      getDayDetails(dateKey) {
        this.success({ ok: true, data: { ...detailFixture.data, date: dateKey } });
      }
    }
    window.google = { script: {} };
    Object.defineProperty(window.google.script, 'run', { get: () => new Runner() });
    if (new URLSearchParams(location.search).get('mode') === 'hover') {
      window.matchMedia = () => ({ matches: true });
      window.setTimeout = (callback) => { callback(); return 1; };
    }
  })();
</script>`;

const interaction = `<script>
  const previewMode = new URLSearchParams(location.search).get('mode');
  if (previewMode === 'hover') {
    window.setTimeout(() => {
      const target = document.querySelector('.day.weekend.interactive');
      if (target) target.dispatchEvent(new Event('pointerenter'));
    }, 300);
  } else if (previewMode === 'modal') {
    window.setTimeout(() => {
      const target = document.querySelector('.day.weekend.interactive');
      if (target) target.click();
    }, 300);
  }
  window.setTimeout(() => {
    const panel = document.querySelector('.panel');
    const grid = document.querySelector('.calendar-grid');
    document.documentElement.dataset.viewportMetrics = JSON.stringify({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      panelWidth: panel && panel.getBoundingClientRect().width,
      gridWidth: grid && grid.getBoundingClientRect().width,
    });
  }, 700);
</script>`;

const preview = source
  .replace('<script>', `${stub}\n    <script>`)
  .replace('</body>', `${interaction}\n  </body>`);

http.createServer((request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(preview);
}).listen(8765, '127.0.0.1', () => {
  console.log('UI preview: http://127.0.0.1:8765');
});
