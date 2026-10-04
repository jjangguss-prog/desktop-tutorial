// 읽기표. 하루 분량은 본문(portion) 목록이다.
//   본문 = { label: '가족 1', segs: [[권, 장], [권, 장, 시작절, 끝절], ...] }
// 한 곳만 읽는 읽기표는 label 이 빈 본문 하나로 이루어진다.
(function (root) {
  'use strict';

  function chapterList(books, ranges) {
    const list = [];
    ranges.forEach(([from, to]) => {
      for (let b = from; b <= to; b++) {
        books[b - 1].verses.forEach((count, i) => list.push({ book: b, chapter: i + 1, verses: count }));
      }
    });
    return list;
  }

  // 장을 나누지 않고, 하루 분량(절 수)이 고르게 되도록 days일로 나눈다.
  function splitBalanced(chapters, days) {
    const result = [];
    let index = 0;
    let remaining = chapters.reduce((sum, c) => sum + c.verses, 0);
    for (let day = 0; day < days; day++) {
      const daysLeft = days - day;
      if (daysLeft === 1) {
        result.push(chapters.slice(index));
        break;
      }
      const target = remaining / daysLeft;
      const today = [];
      let sum = 0;
      while (index < chapters.length) {
        const c = chapters[index];
        const chaptersLeftAfter = chapters.length - index - 1;
        if (today.length && (sum + c.verses / 2 > target || chaptersLeftAfter < daysLeft - 1)) break;
        today.push(c);
        sum += c.verses;
        index++;
      }
      remaining -= sum;
      result.push(today);
    }
    return result.map((day) => day.map((c) => [c.book, c.chapter]));
  }

  const single = (segs) => [{ label: '', segs }];

  // ---------- 진도 + 시가서 ----------
  // 시가서: 욥기(18)·시편(19)·잠언(20)·전도서(21)·아가(22)
  const CUSTOM_MAIN = {
    all: { name: '성경 전체 (시가서 빼고)', ranges: [[1, 17], [23, 66]] },
    ot: { name: '구약 (시가서 빼고)', ranges: [[1, 17], [23, 39]] },
    nt: { name: '신약', ranges: [[40, 66]] },
  };
  const CUSTOM_POETRY = {
    all: { name: '시가서 전체 (욥기~아가)', ranges: [[18, 22]] },
    psprov: { name: '시편·잠언', ranges: [[19, 20]] },
    psalms: { name: '시편', ranges: [[19, 19]] },
    proverbs: { name: '잠언', ranges: [[20, 20]] },
  };
  // poetryStart: 1일째에 읽을 시가서 위치 (분량을 바꿔도 시가서가 읽던 곳에서 이어지게)
  const CUSTOM_DEFAULTS = { main: 'all', mainPerDay: 3, poetry: 'all', poetryPerDay: 1, poetryStart: 0 };

  function normalizeCustom(c) {
    const o = Object.assign({}, CUSTOM_DEFAULTS, c || {});
    if (!CUSTOM_MAIN[o.main]) o.main = CUSTOM_DEFAULTS.main;
    if (!CUSTOM_POETRY[o.poetry]) o.poetry = CUSTOM_DEFAULTS.poetry;
    o.mainPerDay = Math.min(10, Math.max(1, Math.round(o.mainPerDay) || 3));
    o.poetryPerDay = Math.min(5, Math.max(1, Math.round(o.poetryPerDay) || 1));
    o.poetryStart = Math.max(0, Math.round(o.poetryStart) || 0);
    return o;
  }

  // 진도가 끝나는 날까지를 한 바퀴로 본다. 시가서는 다 읽으면 처음부터 다시 돈다.
  function buildCustom(books, c) {
    const main = chapterList(books, CUSTOM_MAIN[c.main].ranges);
    const poetry = chapterList(books, CUSTOM_POETRY[c.poetry].ranges);
    const days = Math.ceil(main.length / c.mainPerDay);
    const result = [];
    for (let d = 0; d < days; d++) {
      const mainSegs = main.slice(d * c.mainPerDay, (d + 1) * c.mainPerDay).map((x) => [x.book, x.chapter]);
      const poetrySegs = [];
      for (let k = 0; k < c.poetryPerDay; k++) {
        const x = poetry[(c.poetryStart + d * c.poetryPerDay + k) % poetry.length];
        poetrySegs.push([x.book, x.chapter]);
      }
      result.push([{ label: '진도', segs: mainSegs }, { label: '시가서', segs: poetrySegs }]);
    }
    return result;
  }

  // ---------- 맥체인 ----------
  const MCHEYNE_LABELS = ['가족 1', '가족 2', '개인 1', '개인 2'];

  function buildMcheyne() {
    const table = root.MCHEYNE || [];
    return table.map((day) => day.map((segs, i) => ({ label: MCHEYNE_LABELS[i], segs })));
  }

  const DEFS = [
    {
      id: 'year',
      name: '1년 1독',
      desc: '성경 전체를 365일 동안, 하루 3~4장',
      build: (books) => splitBalanced(chapterList(books, [[1, 66]]), 365).map(single),
    },
    {
      id: 'mcheyne',
      name: '맥체인',
      desc: '하루 4곳(가족 2·개인 2). 1년에 구약 1번, 신약·시편 2번. 날짜에 맞춰 1월 1일부터',
      calendar: true,
      build: () => buildMcheyne(),
    },
    {
      id: 'custom',
      name: '진도 + 시가서',
      desc: '순서대로 읽는 진도와 시가서를 하루 몇 장씩 함께',
      build: (books, custom) => buildCustom(books, custom),
    },
    {
      id: 'nt',
      name: '신약 260일',
      desc: '마태복음부터 요한계시록까지 하루 1장',
      build: (books) => chapterList(books, [[40, 66]]).map((c) => single([[c.book, c.chapter]])),
    },
    {
      id: 'psalms',
      name: '시편·잠언 181일',
      desc: '시편 150편과 잠언 31장을 하루 1장',
      build: (books) => chapterList(books, [[19, 20]]).map((c) => single([[c.book, c.chapter]])),
    },
    {
      id: 'daily',
      name: '하루 한 장',
      desc: '창세기 1장부터 하루 1장씩, 1,189일',
      build: (books) => chapterList(books, [[1, 66]]).map((c) => single([[c.book, c.chapter]])),
    },
  ];

  const cache = {};

  // 진도 + 시가서는 고른 분량마다 다른 읽기표로 본다 (읽은 기록이 섞이지 않게).
  function getPlan(id, books, custom) {
    const def = DEFS.find((d) => d.id === id) || DEFS[0];
    let planId = def.id;
    let name = def.name;
    let opts = null;
    if (def.id === 'custom') {
      opts = normalizeCustom(custom);
      opts.poetryStart %= chapterList(books, CUSTOM_POETRY[opts.poetry].ranges).length;
      planId = `custom-${opts.main}-${opts.mainPerDay}-${opts.poetry}-${opts.poetryPerDay}`;
      if (opts.poetryStart) planId += `-p${opts.poetryStart}`;
      name = `진도 ${opts.mainPerDay}장 + 시가서 ${opts.poetryPerDay}장`;
    }
    if (!cache[planId]) {
      cache[planId] = { id: planId, base: def.id, name, desc: def.desc, calendar: !!def.calendar, custom: opts, days: def.build(books, opts) };
    }
    return cache[planId];
  }

  // 본문 하나를 읽기 좋게: "창세기 1–3장", "출애굽기 11장, 12:1–21", "시편 119:1–24"
  function describePortion(segs, books) {
    const groups = [];
    segs.forEach(([b, c, from, to]) => {
      let g = groups[groups.length - 1];
      if (!g || g.book !== b) {
        g = { book: b, parts: [] };
        groups.push(g);
      }
      const last = g.parts[g.parts.length - 1];
      if (from == null && last && last.whole && last.to === c - 1) last.to = c;
      else g.parts.push(from == null ? { whole: true, from: c, to: c } : { whole: false, chapter: c, from, to });
    });
    return groups
      .map((g) => {
        const unit = g.book === 19 ? '편' : '장';
        const parts = g.parts.map((p) => {
          if (!p.whole) {
            const max = books[g.book - 1].verses[p.chapter - 1];
            return p.from === p.to ? `${p.chapter}:${p.from}` : `${p.chapter}:${p.from}–${Math.min(p.to, max)}`;
          }
          return (p.from === p.to ? `${p.from}` : `${p.from}–${p.to}`) + unit;
        });
        return `${books[g.book - 1].name} ${parts.join(', ')}`;
      })
      .join(' · ');
  }

  function describe(portions, books) {
    return portions.map((p) => describePortion(p.segs, books)).join(' · ');
  }

  const poetryLength = (books, key) => chapterList(books, CUSTOM_POETRY[key].ranges).length;

  const api = {
    DEFS, CUSTOM_MAIN, CUSTOM_POETRY, CUSTOM_DEFAULTS, poetryLength,
    getPlan, describe, describePortion, normalizeCustom, splitBalanced,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plans = api;
})(typeof window !== 'undefined' ? window : globalThis);
