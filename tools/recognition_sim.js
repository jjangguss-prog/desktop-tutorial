// 음성 인식 흉내 내기: 실제 본문을 '틀리게 알아들은' 글로 바꿔 넣고, 읽은 것으로 얼마나 인정되는지 잰다.
//
//   node tools/recognition_sim.js                 지금 matcher 로 측정
//   node tools/recognition_sim.js 다른/matcher.js  다른 matcher 와 비교
//
// 인식기가 실제로 내는 실수를 흉내 낸다:
//   음절 하나를 비슷한 소리로 잘못 들음, 낱말을 통째로 다른 말로 들음, 낱말을 빠뜨림·덧붙임,
//   옛 표기를 현대 표기로("찌"→"지"), 수를 아라비아 숫자로, 문장 단위로 끊어 들음,
//   인식기가 다시 켜지는 사이에 한 마디를 통째로 놓침, 마디의 첫·끝 낱말을 놓침.
'use strict';
const path = require('path');

global.window = global.window || {};
const root = path.join(__dirname, '..');
require(path.join(root, 'js/books.js'));
require(path.join(root, 'js/mcheyne.js'));
const books = window.BIBLE_BOOKS;
const Plans = require(path.join(root, 'js/plans.js'));
const loaded = {};
window.BIBLE_LOAD = (n, chapters) => { loaded[n] = chapters; };
for (let b = 1; b <= 66; b++) require(path.join(root, `data/books/${String(b).padStart(2, '0')}.js`));

const SKIP_RE = /^\(\d+절에 포함되어 있음\)$/;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = {
  low: { sub: 0.07, word: 0.02, del: 0.02, ins: 0.01, drop: 0.03, trunc: 0.05 },
  mid: { sub: 0.15, word: 0.05, del: 0.04, ins: 0.02, drop: 0.06, trunc: 0.1 },
  high: { sub: 0.25, word: 0.1, del: 0.07, ins: 0.04, drop: 0.1, trunc: 0.15 },
  worst: { sub: 0.35, word: 0.15, del: 0.1, ins: 0.06, drop: 0.15, trunc: 0.2 },
};
const FILLERS = ['어', '음', '그', '아', '저'];
const COMMON = ['그리고', '그래서', '그는', '하나', '이것', '저희', '그날', '말씀', '사람', '주님', '우리'];
const SINO = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };

// "구백육십구" → 969 (한자어 수만 다룸)
function sinoToNumber(word) {
  if (!/^[일이삼사오육칠팔구십백천만]+$/.test(word) || word.length < 2 || !/[십백천만]/.test(word)) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of word) {
    if (SINO[ch]) digit = SINO[ch];
    else if (ch === '만') { total += (section + digit || 1) * 10000; section = 0; digit = 0; }
    else { section += (digit || 1) * { 십: 10, 백: 100, 천: 1000 }[ch]; digit = 0; }
  }
  return total + section + digit;
}

function mishear(word, r) {
  const chars = [...word];
  const k = 1 + (r() < 0.3 ? 1 : 0);
  for (let n = 0; n < k; n++) {
    const i = Math.floor(r() * chars.length);
    const code = chars[i].charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) continue;
    let ini = Math.floor(code / 588);
    let med = Math.floor((code % 588) / 28);
    let fin = code % 28;
    const which = r();
    if (r() < 0.25) {
      ini = Math.floor(r() * 19); med = Math.floor(r() * 21); fin = r() < 0.5 ? 0 : Math.floor(r() * 28);
    } else if (which < 0.4) ini = Math.floor(r() * 19);
    else if (which < 0.75) med = Math.floor(r() * 21);
    else fin = r() < 0.5 ? 0 : Math.floor(r() * 28);
    chars[i] = String.fromCharCode(0xac00 + ini * 588 + med * 28 + fin);
  }
  return chars.join('');
}

function speak(text, noise, r) {
  const out = [];
  for (let word of text.split(/\s+/).filter(Boolean)) {
    word = word.replace(/[^가-힣]/g, '');
    if (!word) continue;
    if (r() < noise.del) continue;
    if (r() < 0.6) word = word.replace(/찌/g, '지');
    const num = sinoToNumber(word);
    if (num != null && r() < 0.7) word = String(num);
    else if (r() < noise.word) word = COMMON[Math.floor(r() * COMMON.length)];
    else if (r() < noise.sub) word = mishear(word, r);
    out.push(word);
    if (r() < noise.ins) out.push(FILLERS[Math.floor(r() * FILLERS.length)]);
  }
  return out;
}

function passageVerses(portions) {
  const verses = [];
  portions.forEach((p) => p.segs.forEach(([b, c, from, to]) => {
    const ch = loaded[b][c - 1];
    for (let v = from || 1; v <= Math.min(to || ch.length, ch.length); v++) {
      verses.push({ text: ch[v - 1], readable: !SKIP_RE.test(ch[v - 1]) });
    }
  }));
  return verses;
}

// 본문 전체를 마디(3~9 낱말)로 끊어 인식 결과처럼 하나씩 넣는다
function readAloud(verses, noise, r, hear) {
  const words = verses.filter((v) => v.readable).flatMap((v) => speak(v.text, noise, r));
  let i = 0;
  while (i < words.length) {
    const len = 3 + Math.floor(r() * 7);
    let chunk = words.slice(i, i + len);
    i += len;
    if (r() < noise.drop) continue; // 인식기가 다시 켜지는 사이에 놓침
    if (r() < noise.trunc) chunk = r() < 0.5 ? chunk.slice(1) : chunk.slice(0, -1);
    if (!chunk.length) continue;
    // 인식기가 내는 다른 후보: 낱말 하나를 다르게 들은 것
    const alt = chunk.slice();
    const j = Math.floor(r() * alt.length);
    alt[j] = mishear(alt[j], r);
    hear([chunk.join(' '), alt.join(' ')]);
  }
}

function baselineTracker(M, passage) {
  const mask = new Uint8Array(passage.chars.length);
  let cursor = 0;
  return {
    hear(alts) {
      const hit = M.matchUtterance(passage, cursor, alts[0]);
      if (hit) { mask.fill(1, hit.start, hit.end); cursor = Math.max(cursor, hit.end); }
    },
    fraction: () => mask.reduce((s, x) => s + x, 0) / mask.length,
    complete() { const f = this.fraction(); return f >= 0.9 || (cursor >= mask.length - 3 && f >= 0.75); },
  };
}

function makeTracker(M, passage) {
  return M.Tracker ? new M.Tracker(passage) : baselineTracker(M, passage);
}

function evaluate(M, label) {
  const yearPlan = Plans.getPlan('year', books);
  const mc = Plans.getPlan('mcheyne', books);
  const samples = [];
  for (let d = 0; d < 365; d += 23) samples.push(yearPlan.days[d]);
  for (let d = 5; d < 365; d += 41) samples.push(mc.days[d]);
  console.log(`\n== ${label} ==  (본문 ${samples.length}개 × 3번)`);
  for (const [level, noise] of Object.entries(NOISE)) {
    let cov = 0;
    let done = 0;
    let n = 0;
    let wordsOk = 0;
    let wordsAll = 0;
    samples.forEach((portions, si) => {
      const verses = passageVerses(portions);
      const passage = M.buildPassage(verses);
      for (let seed = 1; seed <= 3; seed++) {
        const r = rng(si * 101 + seed * 7 + level.length);
        const t = makeTracker(M, passage);
        readAloud(verses, noise, r, (alts) => t.hear(alts));
        cov += t.fraction();
        done += t.complete() ? 1 : 0;
        n++;
        if (t.wordRead) {
          passage.words.forEach((w, wi) => { if (w.end > w.start) { wordsAll++; if (t.wordRead(wi)) wordsOk++; } });
        }
      }
    });
    const wordPart = wordsAll ? ` · 어절 인정 ${(100 * wordsOk / wordsAll).toFixed(1)}%` : '';
    console.log(`인식 오류 ${level.padEnd(4)}  읽은 글자 인정 ${(100 * cov / n).toFixed(1)}% · 다 읽음 처리 ${(100 * done / n).toFixed(0)}%${wordPart}`);
  }

  // 엉뚱한 말(다른 책 본문)을 읽었을 때 잘못 인정되는 양
  const target = M.buildPassage(passageVerses(yearPlan.days[0]));
  const other = passageVerses(yearPlan.days[200]);
  const t = makeTracker(M, target);
  readAloud(other, NOISE.low, rng(99), (alts) => t.hear(alts));
  console.log(`엉뚱한 본문을 읽었을 때 잘못 인정: ${(100 * t.fraction()).toFixed(1)}% (낮을수록 좋음)`);

  // 본문의 앞 60%만 읽고 멈추면 '다 읽음'이 되면 안 된다
  let early = 0;
  samples.forEach((portions, si) => {
    const verses = passageVerses(portions);
    const passage = M.buildPassage(verses);
    const half = verses.slice(0, Math.floor(verses.length * 0.6));
    const tr = makeTracker(M, passage);
    readAloud(half, NOISE.low, rng(500 + si), (alts) => tr.hear(alts));
    if (tr.complete()) early++;
  });
  console.log(`60%만 읽고 멈췄는데 다 읽음 처리: ${early}/${samples.length} (0이어야 함)`);
}

if (require.main === module) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'js/matcher.js');
  evaluate(require(file), path.relative(process.cwd(), file));
}

// 본문 하나를 틀리게 알아들은 인식 결과 목록으로: [[첫째 후보, 다른 후보], ...]
function noisyUtterances(portions, level, seed) {
  const out = [];
  readAloud(passageVerses(portions), NOISE[level], rng(seed), (alts) => out.push(alts));
  return out;
}

module.exports = { evaluate, noisyUtterances, NOISE };
