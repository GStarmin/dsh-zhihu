
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerEvidence, htmlText } from '../lib/core/zhihu-content-evidence.js';
const image = 'v2-' + 'a'.repeat(32) + '_r.jpg';
const body = content => ({ content, question: { title: '测试问题' }, updated_time: 12345 });
const a = `<p>同一段正文。</p><img class="one" src="https://pica.zhimg.com/${image}?source=first" data-original-token="stable"><a href="https://example.test/read?id=1&amp;utm_source=a">来源</a>`;
const b = `<p>同一段正文。</p><img data-original-token="stable" src="https://picx.zhimg.com/${image}?source=second" class="two"><a href="https://example.test/read?utm_source=b&amp;id=1">来源</a>`;
test('same hashed image on rotating Zhihu CDN aliases and different tracking/presentation attributes has stable reading evidence', () => {
  assert.notEqual(a, b); assert.equal(htmlText(a), htmlText(b)); assert.equal(answerEvidence(body(a)), answerEvidence(body(b)));
});
test('real text, title, version, image and external link changes remain protected', () => {
  const original = answerEvidence(body(a));
  for (const changed of [
    body(a.replace('同一段正文', '不同观点')),
    { ...body(a), updated_time: 12346 },
    { ...body(a), question: { title: '不同的问题' } },
    body(a.replace('a'.repeat(32), 'b'.repeat(32))),
    body(a.replace('id=1', 'id=2')),
    body(a.replace('class="one"', 'alt="新增的图片说明"')),
  ]) assert.notEqual(answerEvidence(changed), original);
});
test('unknown hosts and real image transformation parameters are not normalized away', () => {
  assert.notEqual(answerEvidence(body(a)), answerEvidence(body(a.replace('pica.zhimg.com', 'evil.test'))));
  assert.notEqual(answerEvidence(body(a)), answerEvidence(body(a.replace('pica.zhimg.com', 'pica.zhimg.com:444'))));
  assert.notEqual(answerEvidence(body(a)), answerEvidence(body(a.replace('pica.zhimg.com', 'account@pica.zhimg.com'))));
  assert.notEqual(answerEvidence(body(a)), answerEvidence(body(a.replace('source=first', 'source=first&crop=left'))));
  const external = '<a href="https://example.test/read?source=one">来源</a>';
  assert.notEqual(answerEvidence(body(external)), answerEvidence(body(external.replace('source=one', 'source=two'))));
});
test('lazy image placeholders with quoted angle brackets do not replace the real picture identity', () => {
  const one = `<img src='data:image/svg+xml,<svg width="10"></svg>' data-original="https://pica.zhimg.com/${image}">`;
  const two = `<img src='data:image/svg+xml,<svg width="20"></svg>' data-original="https://picx.zhimg.com/${image}">`;
  assert.equal(answerEvidence(body(one)), answerEvidence(body(two)));
  assert.notEqual(answerEvidence(body(one)), answerEvidence(body(two.replace('a'.repeat(32), 'c'.repeat(32)))));
});
test('actual inline pictures without an external source are still part of reading evidence', () => {
  assert.notEqual(answerEvidence(body('<img src="data:image/png;base64,AAAA">')), answerEvidence(body('<img src="data:image/png;base64,BBBB">')));
});
