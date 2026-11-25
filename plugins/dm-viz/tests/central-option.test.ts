import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCentralOption } from '../src/central-option.js';
import { estimateTextWidth } from '../../../packages/platform-viz/src/index.js';
import type { CentralSpec } from '../src/central.js';

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const spec: CentralSpec = {
  width: 1800,
  title: 'Study',
  titleRect: rect(0, 0, 300, 30),
  metas: [
    { text: 'As of 2026-11-15', demo: false, rect: rect(0, 35, 120, 17) },
    { text: 'Synthetic', demo: true, rect: rect(160, 35, 90, 21) },
  ],
  viewLabel: 'Whole-study default view',
  viewLabelRect: rect(1600, 16, 200, 24),
  scope: 'Whole study',
  scopeRect: rect(0, 68, 400, 17),
  themesHeading: 'Prioritized risk themes',
  themesSub: '9 themes',
  themesHeadRect: rect(0, 98, 1800, 19),
  themes: [
    { tone: 'high', badge: '! High', title: 'Theme A', meta: '117 centers', up: '77 worsening', down: '40 improving', links: ['A', 'B'], rect: rect(0, 124, 580, 126) },
    { tone: 'warning', badge: '! Warning', title: 'Theme B', meta: '96 centers', up: '64 worsening', down: '32 improving', links: ['C'], rect: rect(600, 124, 580, 126) },
  ],
  kpis: [
    { title: 'Enrollment', dot: 'rgb(194, 59, 69)', value: '3,268 / 3,968', caption: 'Actual / planned', rect: rect(0, 383, 280, 128) },
    { title: 'Milestone', dot: '', value: '+9 days', caption: 'Variance', rect: rect(300, 383, 280, 128) },
  ],
};

test('central option draws every theme and KPI card', () => {
  const option = buildCentralOption({ spec, width: 1800 });
  const graphic = option.graphic as Array<Record<string, unknown>>;
  const texts = graphic.filter((item) => item.type === 'text').map((item) => (item.style as Record<string, unknown>).text);
  assert.ok(texts.includes('Theme A'));
  assert.ok(texts.includes('Theme B'));
  assert.ok(texts.includes('Enrollment'));
  assert.ok(texts.includes('+9 days'));
  assert.ok(texts.includes('Prioritized risk themes'));
  assert.ok(texts.includes('Whole-study default view'));
});

test('central option draws one card rectangle per theme and KPI', () => {
  const option = buildCentralOption({ spec, width: 1800 });
  const graphic = option.graphic as Array<Record<string, unknown>>;
  const cards = graphic.filter((item) => {
    if (item.type !== 'rect') return false;
    const shape = item.shape as Record<string, unknown>;
    return Number(shape.height) >= 100 && Number(shape.width) >= 200 && Number(shape.width) < 1700;
  });
  assert.equal(cards.length, spec.themes.length + spec.kpis.length);
});

test('central option scales horizontal geometry to canvas width', () => {
  const option = buildCentralOption({ spec, width: 900 });
  const graphic = option.graphic as Array<Record<string, unknown>>;
  const title = graphic.find((item) => item.type === 'text' && (item.style as Record<string, unknown>).text === 'Prioritized risk themes')!;
  assert.equal(title.left, 0);
  const background = graphic[0]!;
  assert.equal((background.shape as Record<string, unknown>).width, 900);
});

test('text width estimate grows with length and weight', () => {
  assert.ok(estimateTextWidth('Longer label', 11) > estimateTextWidth('Short', 11));
  assert.ok(estimateTextWidth('Same', 12, 600) > estimateTextWidth('Same', 12, 400));
});
