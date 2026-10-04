// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/books.js');
const books = window.BIBLE_BOOKS;
const P = require('../js/plans.js');

test('66권, 1,189장', () => {
  assert.strictEqual(books.length, 66);
  assert.strictEqual(books.reduce((s, b) => s + b.verses.length, 0), 1189);
});

for (const def of P.DEFS) {
  test(`${def.name}: 빠지거나 겹치는 장 없이 매일 읽을 분량이 있다`, () => {
    const plan = P.getPlan(def.id, books);
    const seen = new Set();
    plan.days.forEach((day, i) => {
      assert.ok(day.length > 0, `${i + 1}일째가 비어 있음`);
      day.forEach(([b, c]) => {
        const key = `${b}:${c}`;
        assert.ok(!seen.has(key), `${key} 중복`);
        seen.add(key);
      });
    });
    const expected = { year: 1189, nt: 260, psalms: 181, daily: 1189 }[def.id];
    assert.strictEqual(seen.size, expected);
  });
}

test('1년 1독은 365일이고 창세기 1–3장으로 시작해 요한계시록으로 끝난다', () => {
  const plan = P.getPlan('year', books);
  assert.strictEqual(plan.days.length, 365);
  assert.strictEqual(P.describe(plan.days[0], books), '창세기 1–3장');
  assert.match(P.describe(plan.days[364], books), /요한계시록 .*22장$/);
});

test('본문 이름 표기', () => {
  assert.strictEqual(P.describe([[19, 23]], books), '시편 23편');
  assert.strictEqual(P.describe([[1, 50], [2, 1], [2, 2]], books), '창세기 50장 · 출애굽기 1–2장');
});
