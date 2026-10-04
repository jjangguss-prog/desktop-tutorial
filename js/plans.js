// 읽기표. 각 읽기표는 날짜별로 읽을 장 목록([[권 번호, 장], ...])을 만든다.
(function (root) {
  'use strict';

  function chapterRange(books, fromBook, toBook) {
    const list = [];
    for (let b = fromBook; b <= toBook; b++) {
      books[b - 1].verses.forEach((count, i) => list.push({ book: b, chapter: i + 1, verses: count }));
    }
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

  function onePerDay(chapters) {
    return chapters.map((c) => [[c.book, c.chapter]]);
  }

  const DEFS = [
    {
      id: 'year',
      name: '1년 1독',
      desc: '성경 전체를 365일 동안, 하루 3~4장',
      build: (books) => splitBalanced(chapterRange(books, 1, 66), 365),
    },
    {
      id: 'nt',
      name: '신약 260일',
      desc: '마태복음부터 요한계시록까지 하루 1장',
      build: (books) => onePerDay(chapterRange(books, 40, 66)),
    },
    {
      id: 'psalms',
      name: '시편·잠언 181일',
      desc: '시편 150편과 잠언 31장을 하루 1장',
      build: (books) => onePerDay(chapterRange(books, 19, 20)),
    },
    {
      id: 'daily',
      name: '하루 한 장',
      desc: '창세기 1장부터 하루 1장씩, 1,189일',
      build: (books) => onePerDay(chapterRange(books, 1, 66)),
    },
  ];

  const cache = {};

  function getPlan(id, books) {
    const def = DEFS.find((d) => d.id === id) || DEFS[0];
    if (!cache[def.id]) cache[def.id] = { id: def.id, name: def.name, desc: def.desc, days: def.build(books) };
    return cache[def.id];
  }

  // "창세기 1–3장", "시편 119편", "창세기 50장 · 출애굽기 1–2장"
  function describe(chapters, books) {
    const groups = [];
    chapters.forEach(([b, c]) => {
      const last = groups[groups.length - 1];
      if (last && last.book === b && last.to === c - 1) last.to = c;
      else groups.push({ book: b, from: c, to: c });
    });
    return groups
      .map((g) => {
        const unit = g.book === 19 ? '편' : '장';
        const range = g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`;
        return `${books[g.book - 1].name} ${range}${unit}`;
      })
      .join(' · ');
  }

  const api = { DEFS, getPlan, describe, splitBalanced };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plans = api;
})(typeof window !== 'undefined' ? window : globalThis);
