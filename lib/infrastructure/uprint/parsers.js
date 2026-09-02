/**
 * lib/infrastructure/uprint/parsers.js — HTML scraping and table parsing routines.
 * -----------------------------------------------------------------------------
 * Clean, resilient regex-based scrapers extracting data from UprintBD's web pages.
 */

'use strict';

function cellText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCsrfInput(html) {
  if (!html) return null;
  const m = String(html).match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  return m ? m[1] : null;
}

function parseBalance(html) {
  if (!html) return null;
  const m = String(html).match(/Balance:\s*([\d,]+(?:\.\d+)?)\s*Tk/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseCountdownCell(html, recordId) {
  if (!html || !recordId) return 3600;
  const idx = html.indexOf(`id="seconds${recordId}"`);
  if (idx === -1) return 3600;

  const close = html.indexOf('</td>', idx);
  if (close === -1) return 3600;

  const raw = cellText(html.slice(html.indexOf('>', idx) + 1, close));
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n > 0 && n <= 24 * 3600) return n;
  }
  const clock = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const n =
      parseInt(clock[1] || '0', 10) * 3600 +
      parseInt(clock[2], 10) * 60 +
      parseInt(clock[3], 10);
    if (n > 0 && n <= 24 * 3600) return n;
  }
  return 3600;
}

function parseQueuedRecordIds(html) {
  if (!html) return new Set();
  const matches = [...String(html).matchAll(/id="seconds(\d+)"/g)];
  return new Set(matches.map((m) => m[1]));
}

function parsePrintHistory(html) {
  if (!html) return [];
  const anchor = html.indexOf('userPrintHistoryDataTable');
  const region = anchor === -1 ? html : html.slice(anchor);

  const headEnd = region.indexOf('</thead>');
  const headers =
    headEnd === -1
      ? []
      : [...region.slice(0, headEnd).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
          cellText(m[1]).toLowerCase()
        );

  const find = (needle, fallback) => {
    const i = headers.findIndex((h) => h.includes(needle));
    return i === -1 ? fallback : i;
  };

  const COL = {
    dateTime: find('date', 0),
    filename: find('file', 1),
    cost: find('cost', 2),
    copies: find('copies', 3),
    pages: find('page', 4),
    status: find('status', 5),
    device: find('device', 6),
  };

  const bodyStart = region.indexOf('<tbody');
  const bodyEnd = region.indexOf('</tbody>');
  const body =
    bodyStart !== -1 && bodyEnd > bodyStart ? region.slice(bodyStart, bodyEnd) : region;

  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 6) continue;
    const filename = cells[COL.filename] || '';
    if (!filename) continue;

    rows.push({
      dateTime: cells[COL.dateTime] || '',
      filename,
      cost: Number(cells[COL.cost]) || 0,
      copies: parseInt(cells[COL.copies], 10) || 1,
      pages: parseInt(cells[COL.pages], 10) || 1,
      status: cells[COL.status] || '',
      deviceId: cells[COL.device] || '',
    });
  }
  return rows;
}

/**
 * Convert timestamp to Asia/Dhaka YYYY-MM-DD date string (UTC+6).
 */
function dhakaDate(ms) {
  return new Date((ms == null ? Date.now() : ms) + 6 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

module.exports = {
  cellText,
  extractCsrfInput,
  parseBalance,
  parseCountdownCell,
  parseQueuedRecordIds,
  parsePrintHistory,
  dhakaDate,
};
