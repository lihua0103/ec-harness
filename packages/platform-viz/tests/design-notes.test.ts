import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDesignNotes, type DesignCardNotes } from '../src/design-notes.js';

const notes: DesignCardNotes = {
  card: 'b0p0',
  cardRect: { x: 0, y: 0, w: 600, h: 400 },
  chartRect: { x: 15, y: 40, w: 570, h: 300 },
  blocks: [
    { cls: 'review-question', text: 'Question?', position: 'above', rect: { x: 15, y: 20, w: 570, h: 16 }, fontSize: '12px', fontWeight: '600', color: 'rgb(23, 60, 72)', lineHeight: '16px' },
    { cls: 'review-note', text: 'A note below.', position: 'below', rect: { x: 15, y: 350, w: 570, h: 14 }, fontSize: '10px', fontWeight: '400', color: 'rgb(83, 109, 120)', lineHeight: '14px' },
  ],
};

test('notes shift the grid and add graphic texts', () => {
  const option = { grid: { left: 10, top: 40, bottom: 30 }, series: [] };
  const next = applyDesignNotes(option, notes, 570);
  const grid = next.grid as Record<string, number>;
  assert.ok(grid.top > 40, 'top reserve applied');
  assert.ok(grid.bottom > 30, 'bottom reserve applied');
  const texts = (next.graphic as Array<Record<string, unknown>>).map((item) => (item.style as Record<string, unknown>).text);
  assert.deepEqual(texts, ['Question?', 'A note below.']);
});

test('applying twice does not stack reserves or duplicate texts', () => {
  const once = applyDesignNotes({ grid: { top: 40, bottom: 30 }, series: [] }, notes, 570);
  const twice = applyDesignNotes(once, notes, 570);
  assert.deepEqual(twice.grid, once.grid);
  const texts = (twice.graphic as Array<Record<string, unknown>>).filter((item) => item._designNote === true);
  assert.equal(texts.length, 2);
});

test('cards without notes are returned unchanged', () => {
  const option = { grid: { top: 1 }, series: [] };
  const next = applyDesignNotes(option, { ...notes, blocks: [{ ...notes.blocks[0]!, position: 'overlap' }] }, 570);
  assert.equal(next.grid.top, 1);
  assert.equal(next.graphic, undefined);
});
