// 음성 인식 결과와 본문을 맞춰 보는 모듈.
//
// 띄어쓰기는 음성 인식기마다 다르게 나오므로 글자(음절) 단위로 비교한다.
// 인식기는 옛 표기("다닐찌라도")를 현대 표기("다닐지라도")로 쓰고, 이름이나 낯선 낱말은
// 비슷한 소리로 잘못 알아듣는다. 그래서 자모가 비슷한 음절에는 부분 점수를 주고,
// 잘 안 들린 곳이 있어도 앞뒤가 맞으면 그 사이는 읽은 것으로 본다.
(function (root) {
  'use strict';

  const HANGUL_BASE = 0xac00;
  const HANGUL_END = 0xd7a3;

  // 비슷하게 들리는 자모끼리 묶는다.
  // 초성: ㄱㄲㅋ / ㄷㄸㅌ / ㅂㅃㅍ / ㅅㅆ / ㅈㅉㅊ
  const INITIAL_GROUP = [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 8, 8, 8, 0, 2, 5, 9];
  // 중성: ㅐㅔ / ㅒㅖ / ㅙㅚㅞ / ㅢㅣ
  const MEDIAL_GROUP = [0, 1, 2, 3, 4, 1, 6, 3, 8, 9, 10, 10, 12, 13, 14, 10, 16, 17, 18, 20, 20];
  // 종성은 받침 소리(대표음)로: ㄱ / ㄴ / ㄷ(ㅅㅆㅈㅊㅌㅎ) / ㄹ / ㅁ / ㅂ / ㅇ
  const FINAL_GROUP = [0, 1, 1, 1, 4, 4, 4, 7, 8, 1, 16, 8, 8, 8, 17, 8, 16, 17, 17, 7, 7, 21, 7, 7, 1, 7, 17, 7];

  // 맞춰 보는 기준. tools/recognition_sim.js 로 흉내 낸 인식 오류에서 고른 값.
  const TUNING = {
    back: 40, // 읽은 곳보다 이만큼 앞(되읽기)까지 찾는다
    nearAhead: 40, // 바로 이어 읽은 곳으로 보는 범위(말한 길이의 1.6배 + 이만큼)
    farAhead: 400, // 인식기가 몇 문장을 놓쳤을 때 찾아보는 범위
    nearRatio: 0.6, // 가까운 곳에서 인정할 점수: 말한 글자 수 × 이 값
    farRatio: 0.9, // 먼 곳에서 인정할 점수
    strongRatio: 1.2, // 가까운 곳에서 이만큼 맞으면 먼 곳은 찾아보지 않는다
    behindCost: 0.1, // 읽은 곳보다 앞쪽으로 맞추면 글자마다 깎는 점수
    aheadCost: 0.015, // 건너뛰어 맞추면 글자마다 깎는 점수
    gapRatio: 1.3, // 안 들린 말 길이의 이 배까지는 사이를 읽은 것으로 본다
    gapSlack: 12, // 들은 말이 없어도 이만큼(첫 낱말 정도)은 메운다
    maxGap: 300,
    gapMinRatio: 0.8, // 빈틈을 메우려면 이번에 맞은 말의 점수가 말한 글자 수 × 이 값 이상 (엉뚱한 말로 메우지 않게)
    maxUnheard: 600,
    wordShare: 0.5, // 어절 글자의 이만큼을 읽으면 그 어절은 읽은 것
    doneShare: 0.85, // 본문의 이만큼을 읽으면 다 읽음
    doneShareAtEnd: 0.7, // 끝까지 왔으면 이만큼만 읽어도 다 읽음
  };

  function isHangul(code) {
    return code >= HANGUL_BASE && code <= HANGUL_END;
  }

  // 아라비아 숫자를 한자어 수사로 읽는다: 40 → 사십, 153 → 백오십삼
  const DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const SMALL_UNITS = ['', '십', '백', '천'];
  const BIG_UNITS = ['', '만', '억', '조'];

  function numberToSino(numStr) {
    const n = numStr.replace(/^0+/, '');
    if (n === '') return '영';
    if (n.length > 16) return n.split('').map((d) => DIGITS[+d] || '영').join('');
    let out = '';
    const groups = [];
    for (let end = n.length; end > 0; end -= 4) groups.unshift(n.slice(Math.max(0, end - 4), end));
    groups.forEach((g, gi) => {
      let part = '';
      const digits = g.padStart(4, '0').split('').map(Number);
      digits.forEach((d, di) => {
        if (!d) return;
        const unit = SMALL_UNITS[3 - di];
        part += (d === 1 && unit ? '' : DIGITS[d]) + unit;
      });
      if (!part) return;
      const big = BIG_UNITS[groups.length - 1 - gi];
      out += (part === '일' && big === '만' ? '' : part) + big; // 10000 → 만
    });
    return out;
  }

  // 비교에 쓰는 글자만 남긴다: 한글 음절과 영문·숫자. 숫자는 한글로 바꾼다.
  function normalizeSpoken(text) {
    const replaced = String(text || '').replace(/\d+/g, (m) => numberToSino(m));
    const out = [];
    for (const ch of replaced.toLowerCase()) {
      const code = ch.codePointAt(0);
      if (isHangul(code) || (code >= 97 && code <= 122)) out.push(ch);
    }
    return out;
  }

  // 같은 글자 2점. 다르면 초성·중성·종성이 얼마나 비슷한지에 따라 -1 ~ 1.7점.
  function charSimilarity(a, b) {
    if (a === b) return 2;
    const ca = a.charCodeAt(0);
    const cb = b.charCodeAt(0);
    if (!isHangul(ca) || !isHangul(cb)) return -1;
    return syllableSimilarity(ca - HANGUL_BASE, cb - HANGUL_BASE);
  }

  function syllableSimilarity(ia, ib) {
    const i1 = (ia / 588) | 0;
    const i2 = (ib / 588) | 0;
    const m1 = ((ia % 588) / 28) | 0;
    const m2 = ((ib % 588) / 28) | 0;
    const f1 = ia % 28;
    const f2 = ib % 28;
    const si = i1 === i2 ? 1 : INITIAL_GROUP[i1] === INITIAL_GROUP[i2] ? 0.7 : 0;
    const sm = m1 === m2 ? 1 : MEDIAL_GROUP[m1] === MEDIAL_GROUP[m2] ? 0.7 : 0;
    const sf = f1 === f2 ? 1 : FINAL_GROUP[f1] === FINAL_GROUP[f2] ? 0.7 : 0;
    return 3 * (0.35 * si + 0.4 * sm + 0.25 * sf) - 1;
  }

  // 글자를 음절 번호로 (한글이 아니면 -1 - 문자 코드)
  function codesOf(chars) {
    const out = new Int32Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i].charCodeAt(0);
      out[i] = isHangul(c) ? c - HANGUL_BASE : -1 - c;
    }
    return out;
  }

  const GAP = -1;

  // 지역 정렬(Smith-Waterman). 말한 글 전체 중 본문 [lo, hi) 와 가장 잘 맞는 구간을 찾되,
  // 지금 읽는 곳(cursor)에서 멀수록 점수를 깎아 가까운 곳을 고른다.
  function alignNear(spoken, expected, lo, hi, cursor) {
    const m = spoken.length;
    const n = hi - lo;
    if (!m || n <= 0) return null;
    let prevScore = new Float32Array(n + 1);
    let curScore = new Float32Array(n + 1);
    let prevStart = new Int32Array(n + 1);
    let curStart = new Int32Array(n + 1);
    let prevSpokenStart = new Int32Array(n + 1);
    let curSpokenStart = new Int32Array(n + 1);
    let best = null;

    for (let i = 1; i <= m; i++) {
      const s = spoken[i - 1];
      curScore[0] = 0;
      for (let j = 1; j <= n; j++) {
        const e = expected[lo + j - 1];
        const sim = s === e ? 2 : s < 0 || e < 0 ? -1 : syllableSimilarity(s, e);
        const diag = prevScore[j - 1] + sim;
        const up = prevScore[j] + GAP; // 본문에 없는 말을 했음
        const left = curScore[j - 1] + GAP; // 본문 글자를 건너뜀
        let score = 0;
        let start = j - 1;
        let spokenStart = i - 1;
        if (diag > score) {
          score = diag;
          if (prevScore[j - 1] > 0) {
            start = prevStart[j - 1];
            spokenStart = prevSpokenStart[j - 1];
          }
        }
        if (up > score) {
          score = up;
          start = prevStart[j];
          spokenStart = prevSpokenStart[j];
        }
        if (left > score) {
          score = left;
          start = curStart[j - 1];
          spokenStart = curSpokenStart[j - 1];
        }
        curScore[j] = score;
        curStart[j] = start;
        curSpokenStart[j] = spokenStart;
        if (score > 0) {
          const at = lo + start;
          const cost = at < cursor ? (cursor - at) * TUNING.behindCost : (at - cursor) * TUNING.aheadCost;
          const eff = score - cost;
          if (!best || eff > best.eff) {
            best = { score, eff, start: at, end: lo + j, spokenStart, spokenEnd: i };
          }
        }
      }
      [prevScore, curScore] = [curScore, prevScore];
      [prevStart, curStart] = [curStart, prevStart];
      [prevSpokenStart, curSpokenStart] = [curSpokenStart, prevSpokenStart];
    }
    return best;
  }

  // 오늘 읽을 본문 전체를 한 줄의 글자 배열로 만든다.
  // verses: [{ text, readable }] → words(화면에 보여 줄 어절)와 글자 → 어절 대응표
  function buildPassage(verses) {
    const chars = [];
    const charWord = [];
    const words = [];
    verses.forEach((verse, verseIndex) => {
      const tokens = verse.text.split(/\s+/).filter(Boolean);
      tokens.forEach((token) => {
        const word = { text: token, verse: verseIndex, start: chars.length, end: chars.length };
        if (verse.readable) {
          for (const ch of normalizeSpoken(token.replace(/\d+/g, ''))) {
            chars.push(ch);
            charWord.push(words.length);
          }
        }
        word.end = chars.length;
        words.push(word);
      });
    });
    return { chars, charWord, words, codes: codesOf(chars) };
  }

  // 지금 읽는 곳(cursor) 근처에서 말한 글이 맞는 곳을 찾는다.
  // 찾으면 { start, end, score, eff, spokenStart, spokenEnd } — 본문 chars[start, end) 를 읽었다.
  function findUtterance(passage, cursor, spoken) {
    const m = spoken.length;
    if (!m) return null;
    const codes = passage.codes || (passage.codes = codesOf(passage.chars));
    const total = codes.length;
    const c = Math.max(0, Math.min(cursor, total));

    // 1차: 바로 이어지는 곳 (조금 앞으로 되읽은 것도 포함)
    // 아주 짧은 조각("시니")은 엉뚱한 곳과 맞기 쉬우므로 바로 앞에서만 찾는다.
    const nearLo = Math.max(0, c - (m < 6 ? 8 : TUNING.back));
    const nearHi = Math.min(total, c + Math.ceil(m * 1.6) + (m < 6 ? 8 : TUNING.nearAhead));
    let near = alignNear(spoken, codes, nearLo, nearHi, c);
    if (near && near.eff < Math.max(3, m * TUNING.nearRatio)) near = null;
    // 말한 글 대부분이 바로 이어지는 곳과 맞으면 더 볼 것 없다
    if (near && near.eff >= m * TUNING.strongRatio) return near;

    // 2차: 인식기가 몇 문장을 놓쳤거나 잘못 앞서 갔을 수 있으니 넓게, 대신 엄격하게.
    // 가까운 곳에서 일부만 맞았으면 넓은 곳의 더 잘 맞는 자리와 견준다.
    const farLo = Math.max(0, c - 200);
    const farHi = Math.min(total, c + Math.ceil(m * 1.6) + TUNING.farAhead);
    let far = null;
    if (farLo < nearLo || farHi > nearHi) {
      far = alignNear(spoken, codes, farLo, farHi, c);
      if (far && far.eff < Math.max(8, m * TUNING.farRatio)) far = null;
    }
    if (near && far) return far.eff > near.eff ? far : near;
    return near || far;
  }

  function matchUtterance(passage, cursor, spokenText) {
    return findUtterance(passage, cursor, codesOf(normalizeSpoken(spokenText)));
  }

  // 한 본문을 읽어 나가는 상태: 어디까지 읽었는지(cursor), 어느 글자를 읽었는지(mask).
  class Tracker {
    constructor(passage, saved) {
      this.passage = passage;
      this.mask = new Uint8Array(passage.chars.length);
      this.cursor = 0;
      this.unheard = 0; // 지난번에 맞춘 뒤로 본문과 맞지 않았던 말의 글자 수
      if (saved) {
        (saved.ranges || []).forEach(([a, b]) => this.mask.fill(1, Math.max(0, a), Math.min(this.mask.length, b)));
        this.cursor = Math.min(this.mask.length, Math.max(0, saved.cursor || 0));
      }
    }

    get length() {
      return this.mask.length;
    }

    // 확정된 인식 결과. alts: 인식기가 낸 후보들(첫째가 가장 그럴듯함)
    hear(alts) {
      const list = (Array.isArray(alts) ? alts : [alts]).map((t) => codesOf(normalizeSpoken(t))).filter((s) => s.length);
      if (!list.length) return null;
      let best = null;
      for (const spoken of list) {
        const hit = findUtterance(this.passage, this.cursor, spoken);
        if (hit && (!best || hit.eff > best.eff)) best = Object.assign(hit, { m: spoken.length });
      }
      if (!best) {
        this.unheard = Math.min(TUNING.maxUnheard, this.unheard + list[0].length);
        return null;
      }
      // 사이에 잘 안 들린 말이 있었고 그 길이가 건너뛴 본문과 비슷하면, 그 사이도 읽은 것으로 본다
      const gap = best.start - this.cursor;
      const evidence = this.unheard + best.spokenStart;
      let filled = 0;
      const solid = best.eff >= best.m * TUNING.gapMinRatio;
      if (gap > 0 && solid && gap <= TUNING.maxGap && gap <= evidence * TUNING.gapRatio + TUNING.gapSlack) {
        this.mask.fill(1, this.cursor, best.start);
        filled = gap;
      }
      this.mask.fill(1, best.start, best.end);
      this.cursor = best.end;
      this.unheard = best.m - best.spokenEnd; // 끝에서 맞지 않은 말은 다음 빈틈의 근거
      best.filled = filled;
      return best;
    }

    // 아직 확정되지 않은 인식 결과로 미리 보여 줄 위치
    preview(text) {
      const spoken = codesOf(normalizeSpoken(text));
      const hit = spoken.length ? findUtterance(this.passage, this.cursor, spoken) : null;
      return hit ? Math.max(this.cursor, hit.end) : this.cursor;
    }

    // 절 번호를 눌러 읽을 곳을 옮김
    moveTo(pos) {
      this.cursor = Math.max(0, Math.min(this.mask.length, pos));
      this.unheard = 0;
    }

    // 새로 듣기 시작할 때: 지난번에 들은 말은 빈틈 메우기 근거로 쓰지 않는다
    resetEvidence() {
      this.unheard = 0;
    }

    // 다 읽음으로 기록할 때: 인식기가 끝내 못 알아들은 몇 낱말까지 읽은 것으로 칠한다
    markAll() {
      this.mask.fill(1);
      this.cursor = this.mask.length;
      this.unheard = 0;
    }

    reset() {
      this.mask.fill(0);
      this.cursor = 0;
      this.unheard = 0;
    }

    fraction() {
      let n = 0;
      for (let i = 0; i < this.mask.length; i++) n += this.mask[i];
      return this.mask.length ? n / this.mask.length : 0;
    }

    complete() {
      const f = this.fraction();
      return f >= TUNING.doneShare || (this.cursor >= this.mask.length - 15 && f >= TUNING.doneShareAtEnd);
    }

    readCount(start, end) {
      let n = 0;
      for (let k = start; k < end; k++) n += this.mask[k];
      return n;
    }

    wordRead(i) {
      const w = this.passage.words[i];
      const len = w.end - w.start;
      return len > 0 && this.readCount(w.start, w.end) >= Math.ceil(len * TUNING.wordShare);
    }

    ranges() {
      const out = [];
      let s = -1;
      for (let i = 0; i <= this.mask.length; i++) {
        const on = i < this.mask.length && this.mask[i];
        if (on && s < 0) s = i;
        if (!on && s >= 0) {
          out.push([s, i]);
          s = -1;
        }
      }
      return out;
    }
  }

  const api = {
    TUNING, normalizeSpoken, numberToSino, charSimilarity, buildPassage, matchUtterance, Tracker,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
