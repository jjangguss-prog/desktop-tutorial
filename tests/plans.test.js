// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/books.js');
require('../js/mcheyne.js');
const books = window.BIBLE_BOOKS;
const P = require('../js/plans.js');

const allSegs = (plan) => plan.days.flatMap((day) => day.flatMap((p) => p.segs));

test('66권, 1,189장', () => {
  assert.strictEqual(books.length, 66);
  assert.strictEqual(books.reduce((s, b) => s + b.verses.length, 0), 1189);
});

for (const id of ['year', 'nt', 'psalms', 'daily']) {
  test(`${id}: 빠지거나 겹치는 장 없이 매일 읽을 분량이 있다`, () => {
    const plan = P.getPlan(id, books);
    const seen = new Set();
    plan.days.forEach((day, i) => {
      assert.strictEqual(day.length, 1);
      assert.ok(day[0].segs.length > 0, `${i + 1}일째가 비어 있음`);
    });
    allSegs(plan).forEach(([b, c]) => {
      const key = `${b}:${c}`;
      assert.ok(!seen.has(key), `${key} 중복`);
      seen.add(key);
    });
    assert.strictEqual(seen.size, { year: 1189, nt: 260, psalms: 181, daily: 1189 }[id]);
  });
}

test('1년 1독은 365일이고 창세기 1–3장으로 시작해 요한계시록으로 끝난다', () => {
  const plan = P.getPlan('year', books);
  assert.strictEqual(plan.days.length, 365);
  assert.strictEqual(P.describe(plan.days[0], books), '창세기 1–3장');
  assert.match(P.describe(plan.days[364], books), /요한계시록 .*22장$/);
});

test('맥체인: 365일 × 4곳, 구약은 한 번·신약과 시편은 두 번 (절 단위)', () => {
  const plan = P.getPlan('mcheyne', books);
  assert.strictEqual(plan.days.length, 365);
  assert.ok(plan.calendar);
  plan.days.forEach((day) => assert.deepStrictEqual(day.map((p) => p.label), ['가족 1', '가족 2', '개인 1', '개인 2']));
  const count = new Map();
  allSegs(plan).forEach(([b, c, from, to]) => {
    const n = books[b - 1].verses[c - 1];
    for (let v = from || 1; v <= Math.min(to || n, n); v++) {
      const k = `${b}:${c}:${v}`;
      count.set(k, (count.get(k) || 0) + 1);
    }
  });
  books.forEach((book, bi) => {
    const expected = bi + 1 >= 40 || bi + 1 === 19 ? 2 : 1;
    book.verses.forEach((n, ci) => {
      for (let v = 1; v <= n; v++) assert.strictEqual(count.get(`${bi + 1}:${ci + 1}:${v}`), expected, `${book.name} ${ci + 1}:${v}`);
    });
  });
});

test('맥체인 첫날과 마지막 날', () => {
  const plan = P.getPlan('mcheyne', books);
  assert.strictEqual(P.describe(plan.days[0], books), '창세기 1장 · 마태복음 1장 · 에스라 1장 · 사도행전 1장');
  assert.strictEqual(P.describe(plan.days[364], books), '역대하 36장 · 요한계시록 22장 · 말라기 4장 · 요한복음 21장');
});

test('진도 + 시가서: 진도는 순서대로 한 번씩, 시가서는 돌아가며', () => {
  const custom = { main: 'all', mainPerDay: 3, poetry: 'all', poetryPerDay: 1 };
  const plan = P.getPlan('custom', books, custom);
  assert.strictEqual(plan.id, 'custom-all-3-all-1');
  assert.strictEqual(plan.name, '진도 3장 + 시가서 1장');
  assert.strictEqual(plan.days.length, Math.ceil(946 / 3));
  const main = plan.days.flatMap((d) => d[0].segs.map(([b, c]) => `${b}:${c}`));
  assert.strictEqual(new Set(main).size, 946);
  assert.ok(main.every((k) => { const b = Number(k.split(':')[0]); return b < 18 || b > 22; }));
  plan.days.forEach((d) => {
    assert.deepStrictEqual(d.map((p) => p.label), ['진도', '시가서']);
    assert.strictEqual(d[1].segs.length, 1);
    assert.ok(d[1].segs.every(([b]) => b >= 18 && b <= 22));
  });
  assert.strictEqual(P.describe(plan.days[0], books), '창세기 1–3장 · 욥기 1장');
  // 시가서 243장을 다 읽으면 처음으로
  assert.strictEqual(P.describePortion(plan.days[243][1].segs, books), '욥기 1장');
});

test('진도 + 시가서: 시가서 시작 위치를 옮길 수 있다', () => {
  const plan = P.getPlan('custom', books, { main: 'nt', mainPerDay: 2, poetry: 'psalms', poetryPerDay: 2, poetryStart: 149 });
  assert.strictEqual(plan.id, 'custom-nt-2-psalms-2-p149');
  assert.strictEqual(P.describe(plan.days[0], books), '마태복음 1–2장 · 시편 150편, 1편');
  assert.strictEqual(P.getPlan('custom', books, { poetry: 'proverbs', poetryStart: 31 }).id, 'custom-all-3-proverbs-1');
});

test('진도 + 시가서: 이상한 값은 기본값으로', () => {
  assert.deepStrictEqual(P.normalizeCustom({ main: 'x', mainPerDay: 99, poetry: 'psalms', poetryPerDay: 0 }),
    { main: 'all', mainPerDay: 10, poetry: 'psalms', poetryPerDay: 1, poetryStart: 0 });
});

test('본문 이름 표기', () => {
  assert.strictEqual(P.describe([{ label: '', segs: [[19, 23]] }], books), '시편 23편');
  assert.strictEqual(P.describePortion([[1, 50], [2, 1], [2, 2]], books), '창세기 50장 · 출애굽기 1–2장');
  assert.strictEqual(P.describePortion([[2, 11], [2, 12, 1, 21]], books), '출애굽기 11장, 12:1–21');
  assert.strictEqual(P.describePortion([[19, 119, 1, 24]], books), '시편 119:1–24');
  assert.strictEqual(P.describePortion([[38, 13, 1, 1]], books), '스가랴 13:1');
});
