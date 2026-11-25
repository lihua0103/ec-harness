/** dm_dvp_methods 的 topic 归类：不设硬枚举，把枚举值、别名、自然语言归入方法主题，归不进去检索全部主题。
 *  背景（2026-11-24 真实会话）：topic 只接受 5 个枚举值，模型 15 次传入自然语言描述被 INVALID_ARGS 挡回并反复重试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveMethodTopic, ALL_METHOD_TOPICS, METHOD_TOPICS, METHOD_TOPIC_MAP } from '../src/knowledge-seeds.js';

test('枚举值精确命中', () => {
  for (const topic of METHOD_TOPICS) {
    assert.deepEqual(resolveMethodTopic(topic), { topic, matched: 'exact', topics: METHOD_TOPIC_MAP[topic] });
  }
  assert.equal(resolveMethodTopic('  Template ').topic, 'template', '大小写与首尾空白不敏感');
});

test('别名与自然语言描述按关键词归类，不报错', () => {
  const cases: Array<[unknown, string]> = [
    ['fire-when 方言', 'firewhen'],
    ['fire when 怎么写', 'firewhen'],
    ['模板里 Edit Checks 的列语义', 'template'],
    ['方案 PDF 抽取要注意什么', 'protocol'],
    ['UAT 用例和边界', 'uat'],
    ['帮我看看用例设计', 'cases'],
    ['请检索 template 相关的写法', 'template'],
  ];
  for (const [raw, topic] of cases) {
    const r = resolveMethodTopic(raw);
    assert.equal(r.topic, topic, `${JSON.stringify(raw)} → ${topic}`);
    assert.equal(r.matched, 'alias');
    assert.deepEqual(r.topics, METHOD_TOPIC_MAP[topic as keyof typeof METHOD_TOPIC_MAP]);
  }
});

test('没给或归不进去：检索全部主题并如实标记', () => {
  for (const raw of [undefined, null, '', '   ', '日期核对的最佳实践是什么']) {
    const r = resolveMethodTopic(raw);
    assert.equal(r.topic, null, `${JSON.stringify(raw)} 不强行归类`);
    assert.equal(r.matched, 'all');
    assert.deepEqual(r.topics, ALL_METHOD_TOPICS);
  }
  assert.deepEqual(ALL_METHOD_TOPICS, ['template', 'writer', 'firewhen', 'render', 'protocol', 'extraction', 'uat', 'boundary', 'cases', 'design']);
});

test('工具参数不再用 enum/required 把校验挡在执行之前', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const block = host.slice(host.indexOf("name: 'dm_dvp_methods'"), host.indexOf("name: 'dm_dvp_overview'"));
  const topicParam = block.slice(block.indexOf('topic: {'), block.indexOf('projectId: {'));
  assert.ok(topicParam.length > 0, '找到 topic 参数定义');
  assert.ok(!/enum:/.test(topicParam), 'topic 不再是硬枚举');
  assert.ok(!/required: true/.test(topicParam), 'topic 不再必填');
  assert.match(topicParam, /自然语言/, '参数说明告知可以直接描述');
  assert.match(block, /resolveMethodTopic\(args\.topic\)/, '执行时归类');
  assert.match(block, /validTopics/, '结果如实给出可选主题名');
});
