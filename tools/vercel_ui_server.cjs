'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'public');
const port = Number(process.env.DANPRO_PREVIEW_PORT || 8766);
const authenticated = process.env.DANPRO_PREVIEW_AUTH !== 'false';
const symbols = ['◎', '○', '△', '×'];
const labels = ['余裕あり', '対応可能', 'やや混雑', '混雑'];
const weekendCounts = new Map([[5, 0], [6, 0], [12, 1], [13, 3], [19, 5], [20, 2], [26, 4], [27, 6]]);
const days = Array.from({ length: 30 }, (_, index) => {
  const day = index + 1;
  const count = weekendCounts.get(day) ?? index % 7;
  const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : 3;
  return {
    date: `2026-09-${String(day).padStart(2, '0')}`,
    count,
    level,
    symbol: symbols[level],
  };
});

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
  });
  response.end(JSON.stringify(payload));
}

function serveFile(response, filename, contentType) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(fs.readFileSync(path.join(root, filename)));
}

http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/auth/session') {
    return authenticated
      ? json(response, 200, { authenticated: true })
      : json(response, 401, { authenticated: false });
  }
  if (url.pathname === '/api/calendar') {
    return json(response, 200, {
      ok: true,
      data: {
        days,
        levels: symbols.map((symbol, level) => ({ level, symbol, label: labels[level] })),
        updatedAt: '2026-09-25T03:34:56.000Z',
        detailRevision: 'local-preview-revision',
        timeZone: 'Asia/Tokyo',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/local-preview/edit?gid=123',
      },
    });
  }
  if (url.pathname === '/api/day-details') {
    return json(response, 200, {
      ok: true,
      data: {
        date: url.searchParams.get('date'),
        items: [
          { customer: 'サンプル顧客', content: 'パッケージ', work: '印刷', period: 'AM' },
          { customer: 'テスト案件', content: 'カタログ', work: '梱包', period: 'PM' },
        ],
        revision: 'local-preview-revision',
      },
    });
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    response.writeHead(204, { 'Cache-Control': 'private, no-store, max-age=0' });
    return response.end();
  }
  if (url.pathname === '/app.js') return serveFile(response, 'app.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/styles.css') return serveFile(response, 'styles.css', 'text/css; charset=utf-8');
  if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(response, 'index.html', 'text/html; charset=utf-8');
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`Vercel UI preview: http://127.0.0.1:${port}`);
});
