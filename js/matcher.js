// 음성 인식 결과와 본문을 맞춰 보는 모듈.
//
// 띄어쓰기는 음성 인식기마다 다르게 나오므로 글자(음절) 단위로 비교한다.
// 개역한글의 옛 표기("다닐찌라도")와 인식기의 현대 표기("다닐지라도")가
// 어긋나도 읽은 것으로 인정되도록 자모가 비슷한 음절에는 부분 점수를 준다.
(function (root) {
  'use strict';

  const HANGUL_BASE = 0xac00;
  const HANGUL_END = 0xd7a3;

  // 된소리·비슷한 모음은 같은 소리로 본다 (ㄲ→ㄱ, ㄸ→ㄷ, ㅃ→ㅂ, ㅆ→ㅅ, ㅉ→ㅈ / ㅐ↔ㅔ 등)
  const INITIAL_GROUP = [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13];
  const MEDIAL_GROUP = [0, 1, 2, 3, 1, 1, 3, 3, 4, 5, 6, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14];

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

  function charSimilarity(a, b) {
    if (a === b) return 2;
    const ca = a.charCodeAt(0);
    const cb = b.charCodeAt(0);
    if (!isHangul(ca) || !isHangul(cb)) return -1;
    const ia = ca - HANGUL_BASE;
    const ib = cb - HANGUL_BASE;
    const sameInitial = INITIAL_GROUP[Math.floor(ia / 588)] === INITIAL_GROUP[Math.floor(ib / 588)];
    const sameMedial = MEDIAL_GROUP[Math.floor((ia % 588) / 28)] === MEDIAL_GROUP[Math.floor((ib % 588) / 28)];
    const sameFinal = ia % 28 === ib % 28;
    const same = sameInitial + sameMedial + sameFinal;
    if (same === 3) return 1.5;
    if (same === 2) return 0.5;
    return -1;
  }

  const GAP = -1;

  // 지역 정렬(Smith-Waterman). spoken 전체 중 본문 expected[lo, hi) 와 가장 잘 맞는 구간을 찾는다.
  function localAlign(spoken, expected, lo, hi) {
    const m = spoken.length;
    const n = hi - lo;
    if (!m || n <= 0) return null;
    let prevScore = new Float32Array(n + 1);
    let curScore = new Float32Array(n + 1);
    let prevStart = new Int32Array(n + 1);
    let curStart = new Int32Array(n + 1);
    let prevSpokenStart = new Int32Array(n + 1);
    let curSpokenStart = new Int32Array(n + 1);
    let best = { score: 0, start: lo, end: lo, spokenStart: 0, spokenEnd: 0 };

    for (let i = 1; i <= m; i++) {
      curScore[0] = 0;
      const s = spoken[i - 1];
      for (let j = 1; j <= n; j++) {
        const diag = prevScore[j - 1] + charSimilarity(s, expected[lo + j - 1]);
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
        if (score > best.score) {
          best = { score, start: lo + start, end: lo + j, spokenStart, spokenEnd: i };
        }
      }
      [prevScore, curScore] = [curScore, prevScore];
      [prevStart, curStart] = [curStart, prevStart];
      [prevSpokenStart, curSpokenStart] = [curSpokenStart, prevSpokenStart];
    }
    return best.score > 0 ? best : null;
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
    return { chars, charWord, words };
  }

  // 지금까지 읽은 위치(cursor)에서 이어서 읽은 말을 찾는다.
  // 찾으면 { start, end, score } — 본문 chars[start, end) 를 읽은 것으로 본다.
  function matchUtterance(passage, cursor, spokenText) {
    const spoken = normalizeSpoken(spokenText);
    const m = spoken.length;
    if (!m) return null;
    const total = passage.chars.length;
    const lo = Math.max(0, Math.min(cursor, total));

    // 1차: 바로 이어지는 부분에서 찾는다.
    // 아주 짧은 조각("시니")은 엉뚱한 곳과 맞기 쉬우므로 바로 앞에서만 찾는다.
    const nearHi = Math.min(total, lo + Math.ceil(m * 1.6) + (m < 6 ? 6 : 30));
    const near = localAlign(spoken, passage.chars, lo, nearHi);
    if (near && near.score >= Math.max(4, m * 0.5)) return near;

    // 2차: 인식기가 한두 문장을 놓쳤을 수 있으니 더 넓게, 대신 더 엄격하게 찾는다.
    const farHi = Math.min(total, lo + Math.ceil(m * 1.6) + 400);
    if (farHi > nearHi) {
      const far = localAlign(spoken, passage.chars, lo, farHi);
      if (far && far.score >= Math.max(10, m * 0.9)) return far;
    }
    return null;
  }

  const api = { normalizeSpoken, numberToSino, charSimilarity, localAlign, buildPassage, matchUtterance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
