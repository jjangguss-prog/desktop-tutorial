// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/matcher.js');

global.window = global.window || {};
let psalms;
window.BIBLE_LOAD = (n, chapters) => { psalms = chapters; };
require('../data/books/19.js');

function passage(chapterIndex) {
  return M.buildPassage(psalms[chapterIndex].map((text) => ({ text, readable: true })));
}

test('숫자를 한자어 수사로 읽는다', () => {
  assert.deepStrictEqual(['40', '153', '10000', '15000', '100000000', '12', '0'].map(M.numberToSino),
    ['사십', '백오십삼', '만', '만오천', '일억', '십이', '영']);
});

test('띄어쓰기가 달라도 이어서 읽은 곳을 찾는다', () => {
  const p = passage(22); // 시편 23편
  let cursor = 0;
  for (const said of ['여호와는 나의 목자시니', '내가 부족함이없으리로다', '그가 나를 푸른 초장에 누이시며 쉴 만한 물가로 인도하시는도다']) {
    const hit = M.matchUtterance(p, cursor, said);
    assert.ok(hit, said);
    assert.strictEqual(hit.start, cursor);
    cursor = hit.end;
  }
  assert.strictEqual(p.words[p.charWord[cursor - 1]].text, '인도하시는도다');
});

test('옛 표기와 현대 표기가 달라도 인정한다 (다닐찌라도 / 다닐지라도)', () => {
  const p = passage(22);
  const start = p.words.find((w) => w.text === '내가' && w.verse === 3).start;
  const hit = M.matchUtterance(p, start, '내가 사망의 음침한 골짜기로 다닐지라도 해를 두려워하지 않을 것은');
  assert.ok(hit);
  assert.strictEqual(p.words[p.charWord[hit.end - 1]].text, '것은');
});

test('본문과 상관없는 말은 무시한다', () => {
  const p = passage(22);
  assert.strictEqual(M.matchUtterance(p, 0, '오늘 날씨가 참 좋네요'), null);
  assert.strictEqual(M.matchUtterance(p, 0, '잠깐만 전화 좀 받을게'), null);
});

test('인식기가 한 문장을 놓쳐도 다음 문장에서 따라잡는다', () => {
  const p = passage(22);
  const hit = M.matchUtterance(p, 0, '내 영혼을 소생시키시고 자기 이름을 위하여 의의 길로 인도하시는도다');
  assert.ok(hit);
  assert.strictEqual(p.words[p.charWord[hit.start]].verse, 2);
});

test('읽지 않는 절(“…절에 포함되어 있음”)은 글자 목록에서 빠진다', () => {
  const p = M.buildPassage([
    { text: '첫 절', readable: true },
    { text: '(1절에 포함되어 있음)', readable: false },
    { text: '셋째 절', readable: true },
  ]);
  assert.strictEqual(p.chars.join(''), '첫절셋째절');
  assert.strictEqual(p.words.length, 7); // 화면에는 그대로 보인다
});
