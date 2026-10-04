(function () {
  'use strict';

  const books = window.BIBLE_BOOKS;
  const SKIP_RE = /^\(\d+절에 포함되어 있음\)$/;
  const FONT_SIZES = [16, 18, 20, 22, 24, 27, 30];
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  // ---------- 저장 (이 기기의 브라우저에만 남는다) ----------
  const PREFIX = 'bible.';
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) { /* 저장할 수 없는 환경: 이번 방문 동안만 유지 */ }
    },
    clearAll() {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(PREFIX) && k !== PREFIX + 'settings')
          .forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* 무시 */ }
    },
  };

  // ---------- 날짜 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfToday = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);
  const formatDate = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
  const formatShort = (s) => {
    const d = parseYmd(s);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  };

  // ---------- 상태 ----------
  const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const settings = Object.assign({ plan: 'year', starts: {}, font: 2 }, store.get('settings', null) || {});
  if (!settings.starts || typeof settings.starts !== 'object') settings.starts = {};
  if (!Plans.DEFS.some((d) => d.id === settings.plan)) settings.plan = 'year';
  settings.custom = Plans.normalizeCustom(settings.custom);
  if (isYmd(settings.start) && !settings.starts[settings.plan]) settings.starts[settings.plan] = settings.start; // 예전 형식
  delete settings.start;
  if (!(settings.font >= 0 && settings.font < FONT_SIZES.length)) settings.font = 2;
  store.set('settings', settings);

  let view = null; // 화면에 띄운 읽기표 위치 { cycle, index }
  let renderedToday = ymd(startOfToday());
  let day = null; // 지금 화면의 본문
  let readMask = new Uint8Array(0); // 본문 글자마다 읽었는지
  let cursor = 0; // 다음에 읽을 글자 위치
  let tentativeEnd = 0; // 아직 확정되지 않은 인식 결과가 닿은 위치
  let seconds = 0; // 이 본문을 소리 내어 읽은 시간
  let listenStartedAt = 0;
  let listening = false;
  let rec = null;
  let restartTimes = [];
  let misses = 0;
  let wakeLock = null;
  let showToken = 0;

  // ---------- 본문 불러오기 (권별 파일) ----------
  const loadedBooks = {};
  const waiting = {};
  window.BIBLE_LOAD = (n, chapters) => {
    loadedBooks[n] = chapters;
    (waiting[n] || []).forEach((w) => w.resolve());
    delete waiting[n];
  };

  function loadBook(n) {
    if (loadedBooks[n]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const first = !waiting[n];
      (waiting[n] = waiting[n] || []).push({ resolve, reject });
      if (!first) return;
      const s = document.createElement('script');
      s.src = `data/books/${pad(n)}.js`;
      s.onerror = () => {
        (waiting[n] || []).forEach((w) => w.reject(new Error('book ' + n)));
        delete waiting[n];
        s.remove();
      };
      document.head.appendChild(s);
    });
  }

  // ---------- 읽기표 위치 ----------
  // 위치는 { cycle(몇 독째), index(몇 일째) }. 계산할 때는 처음부터 센 번호(abs)로 바꿔 쓴다.
  const currentPlan = () => Plans.getPlan(settings.plan, books, settings.custom);
  const dayKey = (plan, pos) => `${plan.id}:${pos.cycle}:${pos.index}`;
  const absIndex = (plan, pos) => pos.cycle * plan.days.length + pos.index;
  const fromAbs = (plan, n) => ({ cycle: Math.floor(n / plan.days.length), index: n % plan.days.length });

  // 읽기표의 시작일(1일째). 처음 고른 날, 맥체인처럼 날짜에 맞춘 읽기표는 올해 1월 1일.
  function startOf(plan) {
    if (!isYmd(settings.starts[plan.id])) {
      const today = startOfToday();
      settings.starts[plan.id] = plan.calendar ? `${today.getFullYear()}-01-01` : ymd(today);
      saveSettings();
    }
    return settings.starts[plan.id];
  }

  // 시작일로 따진 오늘의 계획 위치. 날짜에 맞춘 읽기표는 2월 29일을 세지 않는다.
  function scheduledPos(plan) {
    const start = parseYmd(startOf(plan));
    const today = startOfToday();
    let n = daysBetween(start, today);
    if (plan.calendar) {
      for (let y = start.getFullYear(); y <= today.getFullYear(); y++) {
        const feb29 = new Date(y, 1, 29);
        if (feb29.getMonth() === 1 && feb29 > start && feb29 <= today) n--;
      }
    }
    return fromAbs(plan, Math.max(0, n));
  }

  // 앱을 열면 갈 곳: 마지막으로 읽던 본문, 그 본문을 다 읽었으면 그다음 본문
  function resumePos(plan) {
    const mark = store.get('bookmarks', {})[plan.id];
    if (!mark || !(mark.cycle >= 0) || !(mark.index >= 0 && mark.index < plan.days.length)) return scheduledPos(plan);
    const done = doneMap();
    let n = absIndex(plan, mark);
    for (let guard = 0; guard < plan.days.length && done[dayKey(plan, fromAbs(plan, n))]; guard++) n++;
    return fromAbs(plan, n);
  }

  function setBookmark() {
    if (!day) return;
    const marks = store.get('bookmarks', {});
    marks[day.info.plan.id] = { cycle: day.info.cycle, index: day.info.index };
    store.set('bookmarks', marks);
  }

  function dayInfo(pos) {
    const plan = currentPlan();
    const portions = plan.days[pos.index];
    return {
      plan, portions,
      multi: portions.length > 1, // 맥체인처럼 하루에 여러 곳을 읽는 날
      cycle: pos.cycle,
      index: pos.index,
      key: dayKey(plan, pos),
      ref: Plans.describe(portions, books),
    };
  }

  // "16절", 여러 장이면 "2장 16절", 여러 곳이면 "에스라 2장 16절"
  function placeLabel(v) {
    const unit = v.book === 19 ? '편' : '장';
    const many = day && (day.info.multi || day.info.portions[0].segs.length > 1);
    const book = day && day.info.multi ? `${books[v.book - 1].name} ` : '';
    return many ? `${book}${v.chapter}${unit} ${v.verse}절` : `${v.verse}절`;
  }

  function renderHead(info) {
    const plan = info.plan;
    $('todayDate').textContent = formatDate(startOfToday());
    $('planName').textContent = plan.name;
    let label = `${info.index + 1}일째 / ${plan.days.length}일`;
    if (info.cycle > 0) label += ` · ${info.cycle + 1}독`;
    $('dayLabel').textContent = label;
    const scheduled = scheduledPos(plan);
    const offPlan = absIndex(plan, scheduled) !== absIndex(plan, info);
    $('scheduleNote').hidden = !offPlan;
    $('scheduleNote').textContent = offPlan ? `계획상 오늘은 ${scheduled.index + 1}일째` : '';
    $('reference').textContent = info.ref.replace(/ · /g, '\u00a0· '); // 줄이 '·'로 시작하지 않게
    $('reference').classList.toggle('multi', info.multi);
    $('resumeBtn').hidden = absIndex(plan, resumePos(plan)) === absIndex(plan, info);
    $('prevDay').disabled = absIndex(plan, info) <= 0;
    document.title = `${info.ref} · 매일 성경 낭독`;
  }

  // 읽을 곳(다음에 읽을 어절)이 화면 위쪽 1/3쯤 오도록 옮긴다
  function scrollToCursor() {
    if (!day || cursor <= 0 || cursor >= day.built.chars.length) return false;
    const el = day.wordEls[day.built.charWord[cursor]];
    const top = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.33;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    return true;
  }

  async function showDay(pos, opts = {}) {
    stopListening();
    const token = ++showToken;
    view = pos;
    const info = dayInfo(pos);
    renderHead(info);
    const passageEl = $('passage');
    passageEl.innerHTML = '<p class="loading">본문을 불러오는 중…</p>';
    $('donePanel').hidden = true;
    $('sheet').classList.remove('complete');

    try {
      const needed = new Set(info.portions.flatMap((p) => p.segs.map((seg) => seg[0])));
      await Promise.all([...needed].map(loadBook));
    } catch (e) {
      if (token === showToken) {
        passageEl.innerHTML = '<p class="loading">본문을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.</p>';
      }
      return;
    }
    if (token !== showToken) return;

    const verses = [];
    info.portions.forEach((portion, pi) => {
      portion.segs.forEach(([b, c, from, to]) => {
        const chapter = loadedBooks[b][c - 1];
        const last = Math.min(to || chapter.length, chapter.length);
        for (let v = from || 1; v <= last; v++) {
          const text = chapter[v - 1];
          verses.push({ portion: pi, book: b, chapter: c, verse: v, text, readable: !SKIP_RE.test(text) });
        }
      });
    });
    const built = Matcher.buildPassage(verses);

    const frag = document.createDocumentFragment();
    const wordEls = [];
    const verseEls = [];
    let chapterKey = '';
    let portionIndex = -1;
    let w = 0;
    verses.forEach((v, vi) => {
      if (info.multi && v.portion !== portionIndex) {
        // 여러 곳을 읽는 날: 본문마다 "가족 1 / 창세기 1장" 같은 머리를 단다
        portionIndex = v.portion;
        chapterKey = '';
        const portion = info.portions[v.portion];
        const head = document.createElement('div');
        head.className = 'portion-head';
        const label = document.createElement('span');
        label.className = 'portion-label';
        label.textContent = portion.label;
        const ref = document.createElement('h2');
        ref.className = 'portion-ref';
        ref.textContent = Plans.describePortion(portion.segs, books);
        head.append(label, ref);
        frag.appendChild(head);
      }
      const key = `${v.portion}:${v.book}:${v.chapter}`;
      if (chapterKey !== key) {
        const firstInPortion = chapterKey === '';
        chapterKey = key;
        // 여러 곳을 읽는 날에는 본문 머리가 장을 알려 주므로, 본문 안에서 장이 바뀔 때만 장 제목을 단다
        if (!info.multi || !firstInPortion) {
          const h = document.createElement(info.multi ? 'h3' : 'h2');
          h.className = 'chapter-title';
          const num = document.createElement('span');
          num.className = 'num';
          num.textContent = v.chapter;
          h.append(num, `${v.book === 19 ? '편' : '장'} · ${books[v.book - 1].name}`);
          frag.appendChild(h);
        }
      }
      const p = document.createElement('p');
      p.className = v.readable ? 'verse' : 'verse skip';
      p.dataset.v = vi;
      const vn = document.createElement('button');
      vn.type = 'button';
      vn.className = 'vn';
      vn.textContent = v.verse;
      vn.setAttribute('aria-label', `${v.verse}절부터 이어서 읽기`);
      p.appendChild(vn);
      while (w < built.words.length && built.words[w].verse === vi) {
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = built.words[w].text;
        p.append(span, ' ');
        wordEls.push(span);
        w++;
      }
      frag.appendChild(p);
      verseEls.push(p);
    });
    passageEl.replaceChildren(frag);
    passageEl.classList.add('idle');

    day = { info, verses, built, wordEls, verseEls };
    renderedToday = ymd(startOfToday());
    restoreProgress();
    updateMarks();
    showHeard('', false);
    setStatus(idleStatus());
    renderCompletion(false);

    const finished = !!doneMap()[info.key];
    if (!finished && scrollToCursor()) {
      if (opts.resume) {
        const v = verses[built.words[built.charWord[cursor]].verse];
        setStatus(`지난번에 이어 ${placeLabel(v)}부터 읽어요`);
      }
      // 글꼴이 늦게 도착하면 줄바꿈이 바뀌므로 한 번 더 맞춘다
      if (document.fonts) {
        document.fonts.ready.then(() => {
          if (token === showToken && !listening) scrollToCursor();
        });
      }
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  // ---------- 읽은 위치 저장 ----------
  const progressKey = () => 'progress.' + day.info.key;

  function restoreProgress() {
    const total = day.built.chars.length;
    readMask = new Uint8Array(total);
    cursor = 0;
    seconds = 0;
    const saved = store.get(progressKey(), null);
    if (saved) {
      (saved.ranges || []).forEach(([a, b]) => readMask.fill(1, Math.max(0, a), Math.min(total, b)));
      cursor = Math.min(total, Math.max(0, saved.cursor || 0));
      seconds = saved.seconds || 0;
    }
    tentativeEnd = cursor;
  }

  function saveProgress() {
    if (!day) return;
    const ranges = [];
    let s = -1;
    for (let i = 0; i <= readMask.length; i++) {
      const on = i < readMask.length && readMask[i];
      if (on && s < 0) s = i;
      if (!on && s >= 0) {
        ranges.push([s, i]);
        s = -1;
      }
    }
    store.set(progressKey(), { ranges, cursor, seconds: Math.round(currentSeconds()) });
  }

  function readFraction() {
    let n = 0;
    for (let i = 0; i < readMask.length; i++) n += readMask[i];
    return readMask.length ? n / readMask.length : 0;
  }

  function updateMarks() {
    if (!day) return;
    const { built, wordEls, verseEls } = day;
    const pos = Math.max(cursor, tentativeEnd);
    const nextWord = pos < built.chars.length ? built.charWord[pos] : -1;
    const verseLen = new Array(verseEls.length).fill(0);
    const verseRead = new Array(verseEls.length).fill(0);

    built.words.forEach((word, i) => {
      const len = word.end - word.start;
      let read = 0;
      for (let k = word.start; k < word.end; k++) read += readMask[k];
      const isRead = len > 0 && read >= Math.ceil(len * 0.6);
      const isTentative = !isRead && len > 0 && word.start < tentativeEnd && tentativeEnd - word.start >= len * 0.6;
      const el = wordEls[i];
      el.classList.toggle('read', isRead);
      el.classList.toggle('tentative', isTentative);
      el.classList.toggle('next', i === nextWord);
      verseLen[word.verse] += len;
      verseRead[word.verse] += read;
    });
    verseEls.forEach((el, vi) => {
      el.classList.toggle('done', verseLen[vi] > 0 && verseRead[vi] >= verseLen[vi] * 0.8);
    });
    $('meterFill').style.width = (readFraction() * 100).toFixed(1) + '%';
  }

  // 읽는 곳이 화면 밖으로 나가면 따라 내려간다
  function followReading() {
    if (!listening || !day) return;
    const pos = Math.max(cursor, tentativeEnd);
    if (pos >= day.built.chars.length) return;
    const el = day.wordEls[day.built.charWord[pos]];
    const rect = el.getBoundingClientRect();
    const bottomLimit = window.innerHeight - $('reader').offsetHeight - 60;
    if (rect.top < window.innerHeight * 0.15 || rect.bottom > bottomLimit) {
      window.scrollBy({ top: rect.top - window.innerHeight * 0.33, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  // ---------- 다 읽음 기록 ----------
  const doneMap = () => store.get('done', {});
  const recordsMap = () => store.get('records', {});

  function checkCompletion() {
    if (!day || doneMap()[day.info.key]) return;
    const frac = readFraction();
    if (frac >= 0.9 || (cursor >= readMask.length - 3 && frac >= 0.75)) completeDay(true);
  }

  function completeDay(byVoice) {
    if (!day) return;
    const today = ymd(startOfToday());
    if (listening) stopListening();
    const done = doneMap();
    done[day.info.key] = today;
    store.set('done', done);
    const records = recordsMap();
    (records[today] = records[today] || []).push({
      key: day.info.key,
      ref: day.info.ref,
      voice: byVoice,
      seconds: Math.round(currentSeconds()),
    });
    store.set('records', records);
    saveProgress();
    setBookmark();
    renderCompletion(true);
    renderRecord();
  }

  function undoDone() {
    if (!day) return;
    const done = doneMap();
    const date = done[day.info.key];
    if (!date) return;
    delete done[day.info.key];
    store.set('done', done);
    const records = recordsMap();
    records[date] = (records[date] || []).filter((r) => r.key !== day.info.key);
    if (!records[date].length) delete records[date];
    store.set('records', records);
    setBookmark();
    renderCompletion(false);
    renderHead(day.info);
    renderRecord();
    setStatus(idleStatus());
  }

  function renderCompletion(justNow) {
    const date = doneMap()[day.info.key];
    $('sheet').classList.toggle('complete', !!date);
    $('donePanel').hidden = !date;
    $('markDoneBtn').hidden = !!date;
    if (!date) return;
    const rec = (recordsMap()[date] || []).find((r) => r.key === day.info.key);
    const parts = [`${date === ymd(startOfToday()) ? '오늘' : formatShort(date)} 기록됨`];
    if (rec && rec.voice) {
      const min = Math.max(1, Math.round((rec.seconds || 0) / 60));
      parts.push(`소리 내어 ${min}분 읽음`);
    } else if (rec) {
      parts.push('직접 표시함');
    }
    $('doneTitle').textContent = date === ymd(startOfToday()) ? '오늘의 말씀을 다 읽었어요' : '이 본문을 다 읽었어요';
    $('doneDetail').textContent = parts.join(' · ');
    $('undoBtn').hidden = !rec || rec.voice;
    const plan = day.info.plan;
    const next = fromAbs(plan, absIndex(plan, day.info) + 1);
    $('nextReadBtn').textContent = `다음 본문 읽기 · ${Plans.describe(plan.days[next.index], books)}`;
    $('nextReadBtn').dataset.abs = absIndex(plan, next);
    if (justNow) renderHead(day.info);
    if (justNow) {
      setStatus('다 읽었어요. 오늘도 수고하셨어요.');
      $('donePanel').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function rereadDay() {
    readMask.fill(0);
    cursor = 0;
    tentativeEnd = 0;
    seconds = 0;
    saveProgress();
    setBookmark();
    updateMarks();
    $('sheet').scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    setStatus('처음부터 다시 들을게요');
  }

  function renderRecord() {
    const records = recordsMap();
    const today = startOfToday();
    let d = records[ymd(today)] ? today : addDays(today, -1);
    let streak = 0;
    while (records[ymd(d)]) {
      streak++;
      d = addDays(d, -1);
    }
    $('streak').textContent = streak;
    $('totalDays').textContent = Object.keys(records).length;

    const grid = $('weeks');
    const frag = document.createDocumentFragment();
    WEEKDAYS.forEach((name) => {
      const el = document.createElement('span');
      el.className = 'wd';
      el.textContent = name;
      frag.appendChild(el);
    });
    const end = addDays(today, 6 - today.getDay());
    for (let i = 34; i >= 0; i--) {
      const date = addDays(end, -i);
      const key = ymd(date);
      const cell = document.createElement('span');
      cell.className = 'cell';
      if (records[key]) cell.classList.add('on');
      if (key === ymd(today)) cell.classList.add('today');
      if (date > today) cell.classList.add('future');
      cell.textContent = date.getDate();
      cell.title = records[key] ? `${formatShort(key)}: ${records[key].map((r) => r.ref).join(', ')}` : formatShort(key);
      frag.appendChild(cell);
    }
    grid.replaceChildren(frag);
  }

  // ---------- 음성 인식 ----------
  const idleStatus = () => (SR ? '버튼을 누르고 본문을 읽어 주세요' : '읽고 나서 ‘다 읽음’을 눌러 주세요');

  function setStatus(text) {
    $('statusText').textContent = text;
  }

  function showHeard(text, miss) {
    const t = String(text || '').trim();
    $('heard').textContent = t.length > 40 ? '…' + t.slice(-40) : t;
    $('heard').classList.toggle('miss', !!miss);
  }

  function currentSeconds() {
    return seconds + (listening && listenStartedAt ? (performance.now() - listenStartedAt) / 1000 : 0);
  }

  function setMicUI() {
    $('micBtn').setAttribute('aria-pressed', String(listening));
    $('micLabel').textContent = listening ? '멈추기' : '소리 내어 읽기';
    $('passage').classList.toggle('idle', !listening);
  }

  // 이어서 읽은 말을 본문에 맞춰 보고, 맞으면 읽은 곳으로 표시한다
  function commitSpeech(text) {
    if (!day || !text) return;
    const hit = Matcher.matchUtterance(day.built, cursor, text);
    if (!hit) {
      misses++;
      $('heard').classList.add('miss');
      if (misses >= 3) setStatus('읽는 곳을 놓쳤어요. 지금 읽는 절의 번호를 눌러 주세요.');
      return;
    }
    misses = 0;
    readMask.fill(1, hit.start, hit.end);
    cursor = Math.max(cursor, hit.end);
    tentativeEnd = cursor;
    if (listening) setStatus('듣고 있어요');
    updateMarks();
    followReading();
    saveProgress();
    setBookmark();
    checkCompletion();
  }

  function previewSpeech(text) {
    if (!day) return;
    const hit = text ? Matcher.matchUtterance(day.built, cursor, text) : null;
    tentativeEnd = hit ? Math.max(cursor, hit.end) : cursor;
    updateMarks();
    followReading();
  }

  // 인식 결과 목록을 하나의 글자열로 합친다. 안드로이드 Chrome처럼
  // 결과마다 앞의 내용을 되풀이하는 경우에는 겹친 부분을 한 번만 센다.
  function sessionTranscript(results) {
    const parts = [];
    for (let i = 0; i < results.length; i++) {
      const t = Matcher.normalizeSpoken(results[i][0].transcript).join('');
      if (!t) continue;
      const prev = parts[parts.length - 1];
      if (prev !== undefined && t.startsWith(prev)) parts[parts.length - 1] = t;
      else if (prev !== undefined && prev.startsWith(t)) continue;
      else parts.push(t);
    }
    return parts.join('');
  }

  function spawnRecognizer() {
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    const session = { consumed: 0, pending: '' };

    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      showHeard(last ? last[0].transcript : '', false);
      const full = sessionTranscript(e.results);
      const fresh = full.slice(session.consumed);
      if (!fresh) {
        session.pending = '';
        previewSpeech('');
        return;
      }
      if (last && last.isFinal) {
        session.consumed = full.length;
        session.pending = '';
        commitSpeech(fresh);
        previewSpeech('');
      } else if (fresh.length > 48) {
        // 길게 이어 읽는 동안에도 앞부분은 확정해 둔다 (끝의 몇 글자는 아직 바뀔 수 있음)
        const stable = fresh.slice(0, fresh.length - 12);
        session.consumed += stable.length;
        session.pending = fresh.slice(stable.length);
        commitSpeech(stable);
        previewSpeech(session.pending);
      } else {
        session.pending = fresh;
        previewSpeech(fresh);
      }
    };

    r.onerror = (e) => {
      if (e.error === 'not-allowed') {
        showNotice('마이크를 쓸 수 없어요. 브라우저 주소창의 자물쇠 아이콘(또는 휴대폰 설정)에서 마이크를 허용한 뒤 다시 눌러 주세요.');
        stopListening();
      } else if (e.error === 'service-not-allowed') {
        showNotice('음성 인식 서비스를 쓸 수 없어요. 아이폰이라면 설정 → 일반 → 키보드에서 ‘받아쓰기 활성화’를 켜고, 홈 화면 앱 대신 Safari에서 열어 보세요.');
        stopListening();
      } else if (e.error === 'audio-capture') {
        showNotice('마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.');
        stopListening();
      } else if (e.error === 'language-not-supported') {
        showNotice('이 브라우저는 한국어 음성 인식을 지원하지 않아요. Chrome이나 Safari로 열어 주세요.');
        stopListening();
      } else if (e.error === 'network') {
        setStatus('음성 인식 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
      // no-speech, aborted 는 onend 에서 다시 시작한다
    };

    r.onend = () => {
      // 확정되지 않고 끝난 말(아이폰 Safari 등)도 놓치지 않는다
      if (session.pending) {
        const pending = session.pending;
        session.pending = '';
        commitSpeech(pending);
      }
      if (rec !== r) return;
      rec = null;
      if (!listening) return;
      const now = Date.now();
      restartTimes = restartTimes.filter((t) => now - t < 15000);
      restartTimes.push(now);
      if (restartTimes.length > 6) {
        stopListening();
        setStatus('음성 인식이 자꾸 끊겨요. 잠시 뒤 다시 눌러 주세요.');
        return;
      }
      setTimeout(() => {
        if (listening && !rec) spawnRecognizer();
      }, 250);
    };

    rec = r;
    try {
      r.start();
    } catch (err) {
      rec = null;
      stopListening();
      setStatus('음성 인식을 시작하지 못했어요. 다시 눌러 주세요.');
    }
  }

  function startListening() {
    if (!SR || !day || listening) return;
    if (cursor >= day.built.chars.length) rereadDay();
    hideNotice();
    listening = true;
    misses = 0;
    restartTimes = [];
    listenStartedAt = performance.now();
    setMicUI();
    setStatus('듣고 있어요. 첫 절부터 소리 내어 읽어 주세요.');
    showHeard('', false);
    spawnRecognizer();
    requestWakeLock();
  }

  function stopListening() {
    if (!listening) return;
    seconds = currentSeconds();
    listening = false;
    listenStartedAt = 0;
    const r = rec;
    rec = null;
    if (r) {
      try { r.stop(); } catch (e) { /* 이미 멈춤 */ }
    }
    tentativeEnd = cursor;
    updateMarks();
    saveProgress();
    setMicUI();
    releaseWakeLock();
    if (day && !doneMap()[day.info.key]) setStatus('멈췄어요. 다시 누르면 이어서 들어요.');
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* 화면 켜짐 유지를 못 해도 읽기는 계속된다 */ }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock) wakeLock.release();
    } catch (e) { /* 무시 */ }
    wakeLock = null;
  }

  function showNotice(text) {
    $('notice').textContent = text;
    $('notice').hidden = false;
  }

  function hideNotice() {
    if (!$('notice').dataset.sticky) $('notice').hidden = true;
  }

  // ---------- 설정 ----------
  function applyFont() {
    document.documentElement.style.setProperty('--scripture-size', FONT_SIZES[settings.font] + 'px');
    $('fontValue').textContent = FONT_SIZES[settings.font] + 'px';
  }

  function saveSettings() {
    store.set('settings', settings);
  }

  function fillSelect(el, options, value) {
    el.replaceChildren(
      ...options.map(([v, text]) => {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = text;
        o.selected = String(v) === String(value);
        return o;
      })
    );
  }

  function renderCustom() {
    const c = settings.custom;
    $('customPlan').hidden = settings.plan !== 'custom';
    fillSelect($('customMain'), Object.entries(Plans.CUSTOM_MAIN).map(([k, v]) => [k, v.name]), c.main);
    fillSelect($('customMainPerDay'), [...Array(10)].map((_, i) => [i + 1, `하루 ${i + 1}장`]), c.mainPerDay);
    fillSelect($('customPoetry'), Object.entries(Plans.CUSTOM_POETRY).map(([k, v]) => [k, v.name]), c.poetry);
    fillSelect($('customPoetryPerDay'), [...Array(5)].map((_, i) => [i + 1, `하루 ${i + 1}장`]), c.poetryPerDay);
    const plan = Plans.getPlan('custom', books, c);
    $('customSummary').textContent = `하루 ${c.mainPerDay + c.poetryPerDay}장 · ${plan.days.length}일이면 진도를 한 번 다 읽어요. 시가서는 다 읽으면 처음부터 다시 읽어요.`;
  }

  // 분량을 바꿔도 진도와 시가서가 각각 읽던 곳에서 이어진다
  function onCustomChange() {
    const marks = store.get('bookmarks', {});
    const oldPlan = currentPlan();
    const old = oldPlan.custom;
    const hadProgress = settings.plan === 'custom' && !!marks[oldPlan.id];
    const oldResume = resumePos(oldPlan);
    const next = Plans.normalizeCustom({
      main: $('customMain').value,
      mainPerDay: Number($('customMainPerDay').value),
      poetry: $('customPoetry').value,
      poetryPerDay: Number($('customPoetryPerDay').value),
    });
    let index = 0;
    if (hadProgress) {
      // 진도: 범위가 같으면 읽은 장 수만큼 이어서, 범위가 바뀌면 처음부터
      if (old.main === next.main) {
        const mainLength = Plans.getPlan('custom', books, next).days.length;
        index = Math.min(mainLength - 1, Math.floor((oldResume.index * old.mainPerDay) / next.mainPerDay));
      }
      // 시가서: 범위가 같으면 다음에 읽을 장부터, 바뀌면 처음부터
      const len = Plans.poetryLength(books, next.poetry);
      const at = old.poetry === next.poetry ? old.poetryStart + oldResume.index * old.poetryPerDay : 0;
      next.poetryStart = (((at - index * next.poetryPerDay) % len) + len) % len;
    }
    settings.custom = next;
    const plan = currentPlan();
    if (hadProgress) {
      marks[plan.id] = { cycle: 0, index };
      store.set('bookmarks', marks);
      settings.starts[plan.id] = ymd(addDays(startOfToday(), -index));
    }
    saveSettings();
    $('startDate').value = startOf(plan);
    renderCustom();
    settingsChanged = true;
  }

  const customPlanEl = $('customPlan');

  function renderPlanList() {
    const list = $('planList');
    list.replaceChildren(
      ...Plans.DEFS.map((def) => {
        const label = document.createElement('label');
        label.className = 'plan';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'plan';
        input.id = 'plan-' + def.id;
        input.value = def.id;
        input.checked = settings.plan === def.id;
        const name = document.createElement('b');
        name.textContent = def.name;
        const desc = document.createElement('small');
        desc.textContent = def.desc;
        label.append(input, name, desc);
        return label;
      })
    );
    // 진도·시가서 분량 고르는 칸은 '진도 + 시가서' 바로 아래에
    $('plan-custom').closest('label').after(customPlanEl);
  }

  let settingsChanged = false;
  let resetArmed = null;

  function openSettings() {
    stopListening();
    settingsChanged = false;
    renderPlanList();
    renderCustom();
    $('startDate').value = startOf(currentPlan());
    applyFont();
    disarmReset();
    const dlg = $('settings');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function disarmReset() {
    clearTimeout(resetArmed);
    resetArmed = null;
    $('resetBtn').textContent = '기록 모두 지우기';
  }

  // ---------- 이벤트 ----------
  $('micBtn').addEventListener('click', () => (listening ? stopListening() : startListening()));
  $('markDoneBtn').addEventListener('click', () => completeDay(false));
  $('rereadBtn').addEventListener('click', rereadDay);
  $('undoBtn').addEventListener('click', undoDone);
  const goAbs = (n) => showDay(fromAbs(currentPlan(), Math.max(0, n)));
  const goResume = () => showDay(resumePos(currentPlan()), { resume: true });
  $('prevDay').addEventListener('click', () => goAbs(absIndex(currentPlan(), view) - 1));
  $('nextDay').addEventListener('click', () => goAbs(absIndex(currentPlan(), view) + 1));
  $('resumeBtn').addEventListener('click', goResume);
  $('nextReadBtn').addEventListener('click', (e) => goAbs(Number(e.currentTarget.dataset.abs)));
  $('settingsBtn').addEventListener('click', openSettings);

  $('passage').addEventListener('click', (e) => {
    const btn = e.target.closest('.vn');
    if (!btn || !day) return;
    const vi = Number(btn.parentElement.dataset.v);
    const first = day.built.words.find((w) => w.verse === vi && w.end > w.start);
    if (!first) return;
    cursor = first.start;
    tentativeEnd = cursor;
    misses = 0;
    updateMarks();
    saveProgress();
    setBookmark();
    setStatus(`${placeLabel(day.verses[vi])}부터 이어서 들을게요`);
  });

  $('planList').addEventListener('change', (e) => {
    if (e.target.name !== 'plan') return;
    settings.plan = e.target.value;
    $('startDate').value = startOf(currentPlan()); // 처음 고른 읽기표는 오늘부터(맥체인은 1월 1일부터)
    renderCustom();
    saveSettings();
    settingsChanged = true;
  });

  $('startDate').addEventListener('change', (e) => {
    if (!isYmd(e.target.value)) return;
    const planId = currentPlan().id;
    settings.starts[planId] = e.target.value;
    saveSettings();
    // 시작일을 새로 정하면 그 날짜로 따진 오늘 본문부터 읽는다
    const marks = store.get('bookmarks', {});
    delete marks[planId];
    store.set('bookmarks', marks);
    settingsChanged = true;
  });

  ['customMain', 'customMainPerDay', 'customPoetry', 'customPoetryPerDay'].forEach((id) => {
    $(id).addEventListener('change', onCustomChange);
  });

  $('fontDown').addEventListener('click', () => {
    settings.font = Math.max(0, settings.font - 1);
    applyFont();
    saveSettings();
  });
  $('fontUp').addEventListener('click', () => {
    settings.font = Math.min(FONT_SIZES.length - 1, settings.font + 1);
    applyFont();
    saveSettings();
  });

  $('resetBtn').addEventListener('click', () => {
    if (!resetArmed) {
      $('resetBtn').textContent = '한 번 더 누르면 모두 지워져요';
      resetArmed = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    store.clearAll();
    $('resetBtn').textContent = '지웠어요';
    settingsChanged = true;
  });

  $('settings').addEventListener('close', () => {
    if (settingsChanged) {
      goResume();
      renderRecord();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopListening();
    } else if (ymd(startOfToday()) !== renderedToday) {
      // 날이 바뀐 뒤 다시 열면 이어 읽을 곳으로
      goResume();
      renderRecord();
    }
  });

  // ---------- 시작 ----------
  // 새로고침할 때 브라우저가 예전 스크롤 위치로 되돌리지 않게 한다 (읽을 곳으로 직접 옮김)
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  applyFont();
  if (!SR) {
    $('micBtn').disabled = true;
    $('notice').dataset.sticky = '1';
    showNotice('이 브라우저에서는 음성 인식을 쓸 수 없어요. 안드로이드·PC는 Chrome, 아이폰·아이패드는 Safari로 열어 주세요. 카카오톡 같은 앱 안의 브라우저에서는 동작하지 않을 수 있어요. 그동안은 읽고 나서 ‘다 읽음’을 눌러 기록할 수 있어요.');
    setStatus('읽고 나서 ‘다 읽음’을 눌러 주세요');
  } else if (!window.isSecureContext) {
    $('notice').dataset.sticky = '1';
    showNotice('마이크는 https 주소(또는 내 컴퓨터의 localhost)에서만 쓸 수 있어요. GitHub Pages 주소로 열어 주세요.');
  }
  goResume();
  renderRecord();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
