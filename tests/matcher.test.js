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

// ---------- 읽어 나가기 (Tracker) ----------
const genesis = (() => {
  let g;
  window.BIBLE_LOAD = (n, chapters) => { g = chapters; };
  require('../data/books/01.js');
  return M.buildPassage(g[0].map((text) => ({ text, readable: true })));
})();
const verseRange = (p, v) => {
  const ws = p.words.filter((w) => w.verse === v);
  return [ws[0].start, ws[ws.length - 1].end];
};

test('잘 안 들린 마디가 있어도 앞뒤가 맞으면 그 사이는 읽은 것으로 본다', () => {
  const t = new M.Tracker(genesis);
  t.hear(['태초에 하나님이 천지를 창조하시니라']);
  assert.strictEqual(t.hear(['오늘 저녁 친구들과 맛있는 걸 먹으러 가요']), null); // 2절 앞부분을 엉뚱하게 알아들음
  const hit = t.hear(['하나님의 신은 수면에 운행하시니라']);
  assert.ok(hit && hit.filled > 0);
  const [a, b] = verseRange(genesis, 1); // 2절
  assert.strictEqual(t.readCount(a, b), b - a);
});

test('건너뛴 절은 읽은 것으로 치지 않는다', () => {
  const t = new M.Tracker(genesis);
  t.hear(['태초에 하나님이 천지를 창조하시니라']);
  t.hear(['하나님이 가라사대 빛이 있으라 하시매 빛이 있었고']); // 2절을 건너뜀
  const [a, b] = verseRange(genesis, 1);
  assert.ok(t.readCount(a, b) < (b - a) * 0.3);
});

test('후보 중 본문과 가장 잘 맞는 것을 쓴다', () => {
  const t = new M.Tracker(genesis);
  const hit = t.hear(['대추에 한 나무 이 천지를 창조', '태초에 하나님이 천지를 창조하시니라']);
  assert.ok(hit);
  assert.strictEqual(t.cursor, verseRange(genesis, 0)[1]);
});

test('잘못 앞서 나갔어도 되읽으면 제자리로 돌아온다', () => {
  const t = new M.Tracker(genesis);
  t.moveTo(verseRange(genesis, 5)[0]); // 6절로 잘못 옮겨졌다고 치자
  t.hear(['하나님이 가라사대 빛이 있으라 하시매 빛이 있었고']); // 실제로는 3절을 읽음
  assert.strictEqual(t.cursor, verseRange(genesis, 2)[1]);
});

test('엉뚱한 말은 읽은 것으로 치지 않는다', () => {
  const t = new M.Tracker(genesis);
  for (const said of ['오늘 점심은 뭐 먹을까', '전화 좀 받고 올게', '잠깐만 기다려 봐', '물 한 잔 줄래']) t.hear([said]);
  assert.ok(t.fraction() < 0.01);
});

test('끝까지 읽으면 다 읽음, 절반만 읽으면 아니다', () => {
  const verses = genesis.words.reduce((acc, w) => { (acc[w.verse] = acc[w.verse] || []).push(w.text); return acc; }, []).map((ws) => ws.join(' '));
  const half = new M.Tracker(genesis);
  verses.slice(0, 15).forEach((v) => half.hear([v]));
  assert.strictEqual(half.complete(), false);
  const full = new M.Tracker(genesis);
  verses.forEach((v, i) => full.hear([i % 4 === 1 ? '잘 안 들림 음 어' : v])); // 네 절에 하나는 알아듣지 못함
  assert.strictEqual(full.complete(), true);
});

test('저장했다가 다시 불러온다', () => {
  const t = new M.Tracker(genesis);
  t.hear(['태초에 하나님이 천지를 창조하시니라']);
  const again = new M.Tracker(genesis, { ranges: t.ranges(), cursor: t.cursor });
  assert.strictEqual(again.cursor, t.cursor);
  assert.strictEqual(again.fraction(), t.fraction());
});
