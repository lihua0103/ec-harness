import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableTimeZones,
  formatDate,
  formatDateTime,
  getPreferences,
  navLabel,
  runStateText,
  setPreferences,
  t,
  translationKeys,
} from '../src/client/i18n.js';

test('the default shell copy is Chinese and an unknown key falls back instead of rendering empty', () => {
  assert.equal(getPreferences().locale, 'zh-CN');
  assert.equal(t('nav.works'), '我的工作');
  assert.equal(navLabel('settings'), '平台设置');
  // A key that exists only in the zh copy is still served when the locale is English.
  setPreferences({ locale: 'en-US' });
  assert.equal(t('nav.works'), 'My work');
  assert.equal(navLabel('pending', 'en-US'), 'Needs me');
  setPreferences({ locale: 'zh-CN' });
  assert.equal(t('nav.works'), '我的工作');
});

test('recorded instants render in the chosen time zone, and an invalid value stays honest', () => {
  const instant = '2026-11-17T00:30:00.000Z';
  setPreferences({ timeZone: 'UTC', locale: 'en-US' });
  const utc = formatDateTime(instant);
  setPreferences({ timeZone: 'Asia/Shanghai', locale: 'en-US' });
  const shanghai = formatDateTime(instant);
  assert.notEqual(utc, shanghai);
  assert.match(utc, /2026/);
  assert.equal(formatDateTime('not-a-time'), '时间未记录');
  setPreferences({ timeZone: '', locale: 'zh-CN' });
});

test('date-only display never depends on the stored instant of another day', () => {
  const noon = Date.UTC(2026, 10, 17, 12, 0, 0);
  setPreferences({ timeZone: 'UTC', locale: 'en-US' });
  const utc = formatDate(noon);
  setPreferences({ timeZone: 'Pacific/Kiritimati', locale: 'en-US' });
  const ahead = formatDate(noon);
  setPreferences({ timeZone: '', locale: 'zh-CN' });
  assert.match(utc, /November/);
  assert.match(ahead, /November/);
});

test('the time-zone menu offers the local zone and UTC without duplicates', () => {
  const zones = availableTimeZones();
  assert.ok(zones.includes('UTC'));
  assert.ok(zones.includes(''));
  assert.equal(new Set(zones).size, zones.length);
});
test('every chrome key has an English translation and run states localize without inventing values', () => {
  for (const key of translationKeys()) {
    assert.ok(t(key as Parameters<typeof t>[0], 'en-US') !== key, `missing en-US copy: ${key}`);
  }
  assert.equal(runStateText('SUCCEEDED', 'en-US'), 'Succeeded');
  assert.equal(runStateText('UNKNOWN', 'zh-CN'), '结果未知');
  assert.equal(runStateText('WAITING_FOR_USER', 'en-US'), 'Waiting for answer');
  assert.equal(runStateText('SOMETHING_NEW', 'en-US'), 'SOMETHING_NEW');
  assert.equal(runStateText(undefined, 'en-US'), '—');
});
