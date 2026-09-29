/**
 * AppAPI.gs — 문구판 웹앱 · 2026-09-27 Claude 작성 (v2: 같은 날 PD 결정 반영)
 *
 * 목적 하나: "지금 유효하면서 우리 채널에도 잘 맞는 제목은?" — 검증된 기성 문구를 빨리 찾는 화면.
 * 원칙: 읽기 전용. 쓰기는 '내 판정' 탭뿐(J열 판정 · 판정이 바뀐 행의 L~O 비우기 · 문구판에서 처음 판정한 영상의 새 행).
 *       순위·추천 없음(정렬·필터만). 기존 .gs 파일과 두 시트의 구조는 건드리지 않는다.
 *
 *  - AP_setup      1회 실행: 보관 파일 + 스냅샷 트리거 2개(23:15경·08:30경) + 편집 트리거 + 첫 스냅샷
 *  - doGet         문구판 화면(AppUI.html). ?format=json 이면 데이터 JSON
 *  - doPost        {"id":"영상ID","text":"판정","prev":"고치기 전 판정"} → AP_save
 *  - AP_getData    화면 데이터 = 스냅샷 + '내 판정' 실시간 상태
 *  - AP_save       판정 저장. 이미 적힌 칸은 prev가 맞을 때만 고친다
 *  - AP_rebuild    화면의 '새로 고침' — 스냅샷 즉시 재생성
 *  - AP_scheduled  시간 트리거(23:15경: 20시 수집·PL_run 뒤, 20~22시 혼잡을 피해 / 08:30경: 밤사이 문구 판독·08:04 쇼츠 갱신 뒤)
 *  - AP_onEdit     시트에서 J열을 직접 고쳐도 L~O를 비워 PL_numericize_가 새 판정으로 다시 채우게 한다
 *
 * 스냅샷 보관: CacheService(빠른 길) + 별도 파일 '문구판 캐시'(영구, 2번째 탭 '분류' = 자동 대분류 캐시).
 */
var AP = {
  SS_A: '1J5ZTIQuTeFyT3TP8kdNiphPcYVm-ZPw2QXcbIn-K1rU', // 주요 선도채널 콘텐츠 DB
  SS_B: '1L-SK3wPfQMWR1nNkxHZvDHG7OryUo7UdkrdJk-mqIZc', // 부읽남TV 콘텐츠 DB ('쇼츠 참고'·'급등 트렌드')
  OWN: '부읽남TV', TZ: 'Asia/Seoul',
  REF_DAYS: 10,              // 레퍼런스 = 최근 10일 (자사 롱폼은 영상DB 전체 = 최근 30일)
  NEED_X: 3.0,               // PD 09-27: '내 판정'에 없는 레퍼런스도 배수 3.0 이상이면 판정 필요(파이프라인 경쟁사 후보 기준 배수와 같은 값)
  SHORTS_FROM: '2026-07-01', // PD 09-27: 쇼츠는 7월 1일 이후 게시분만
  RISE_MAX: 100,             // '다시 뜨는 자사 영상' 표시 상한(급등 트렌드 순위순)
  NEW_KIND: '문구판 직접',    // 문구판에서 처음 판정해 '내 판정'에 새로 넣는 행의 선별 종류
  T: { db: '영상DB', th: '썸네일 문구', lab: '통합_문구DB', judge: '내 판정', guest: '출연자_영상요약', verdict: '제목판정DB', shorts: '쇼츠 참고', trend: '급등 트렌드' },
  JUDGE: { head: 3, idCol: 3, textCol: 10, textName: '내 판정(서술)', numCol: 12, numN: 4 }, // C 영상ID, J 내 판정(서술), L~O 숫자화 — Pipeline.gs가 고정한 위치
  WARN: ['일부 과장', '내용과 불일치'], // 제목판정DB에서 경고 배지로만 보일 판정
  CACHE: 'AP_SNAP', CACHE_CHUNK: 30000, CELL_CHUNK: 45000, PROP_STORE: 'AP_STORE_ID',
  // 대분류가 없는 카드(레퍼런스·쇼츠·주간 라벨 전 자사)만 Gemini로 분류해 화면 필터에만 쓴다. 통합_문구DB에는 쓰지 않는다.
  CLS: { sheet: '분류', batch: 50, budgetMs: 150000, models: ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] },
  CATS: { // README 09-23 PD 확정 분류표
    '부동산': ['시황', '정책', '전월세', '대응방안(서울)', '대응방안(수도권)', '대응방안(일반)', '청약분양', '재건축재개발', '세금'],
    '주식': ['시황', '반도체', '주요섹터', '그외추천섹터', '자산배분', '노후대비', '미국주식', 'ETF'],
    '경제(전망)': ['금리', '환율', '물가', '경기고용', '통화정책', '한국전망'],
    '금은코인': ['금', '은', '비트코인', '알트코인', '스테이블코인', '규제ETF'],
    '국제정세': ['미국', '중국', '지정학', '무역관세'],
    '투자마인드': ['재테크기초', '저축', '투자원칙', '실패담', '부자인터뷰', '자산배분'],
    '라이프': ['AI활용', '인간관계', '건강다이어트', '창업', '자기계발', '기타']
  }
};

// 편집기 ▶ 실행 드롭다운 기본값이 이 파일의 첫 함수이므로 AP_setup을 맨 위에 둔다.
function AP_setup() {
  AP_store_(true);
  ScriptApp.getProjectTriggers().filter(function (t) { return ['AP_nightly', 'AP_scheduled', 'AP_onEdit'].indexOf(t.getHandlerFunction()) >= 0; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('AP_scheduled').timeBased().everyDays(1).atHour(23).nearMinute(15).inTimezone(AP.TZ).create(); // PD 09-27: 20~22시는 수집·제목 판정·판독이 몰려 Gemini가 느림
  ScriptApp.newTrigger('AP_scheduled').timeBased().everyDays(1).atHour(8).nearMinute(30).inTimezone(AP.TZ).create();
  ScriptApp.newTrigger('AP_onEdit').forSpreadsheet(AP.SS_A).onEdit().create();
  console.log('AP_setup 완료 · 스냅샷 트리거 2개(23:15경·08:30경) + 편집 트리거 1개 · ' + AP_buildSnapshot(240000)); // 첫 자동 분류는 길어서 여유(실행 한도 6분)
}

function AP_scheduled() { console.log('AP_scheduled · ' + AP_buildSnapshot(AP.CLS.budgetMs)); }
function AP_nightly() { AP_scheduled(); } // v1 트리거 이름(AP_setup이 지우고 새로 건다)

// 시트에서 J열(내 판정)을 사람이 직접 고치면 그 행의 L~O를 비운다 → 30분 안에 PL_numericize_가 새 판정으로 다시 채운다.
// L~O까지 함께 붙여 넣은 편집은 건드리지 않는다. 스크립트가 쓴 값에는 이 트리거가 돌지 않는다.
function AP_onEdit(e) {
  try {
    var r = e && e.range; if (!r) return;
    var sh = r.getSheet(); if (sh.getName() !== AP.T.judge) return;
    var J = AP.JUDGE, c0 = r.getColumn(), c1 = r.getLastColumn();
    if (c0 > J.textCol || c1 < J.textCol || c1 >= J.numCol) return;
    var r0 = Math.max(r.getRow(), J.head + 1), r1 = r.getLastRow(); if (r1 < r0) return;
    if (r0 === r1 && e.oldValue !== undefined && String(e.oldValue) === String(e.value)) return;
    sh.getRange(r0, J.numCol, r1 - r0 + 1, J.numN).clearContent();
  } catch (err) { console.log('AP_onEdit: ' + err); }
}

// ══════════════════════════════ 웹앱 ══════════════════════════════
function doGet(e) {
  var p = (e && e.parameter) || {}, data;
  try { data = AP_getData(); } catch (err) { data = JSON.stringify({ error: String(err && err.message || err) }); }
  if (p.format === 'json') return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
  var t = HtmlService.createTemplateFromFile('AppUI');
  t.boot = data.replace(/</g, '\\u003c'); // <script type="application/json"> 안에 안전하게 싣기
  return t.evaluate().setTitle('문구판').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var out;
  try { var b = JSON.parse(e.postData.contents); out = AP_save(b.id, b.text, b.prev); } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// 화면 데이터(JSON 문자열). 스냅샷은 문자열 그대로 붙여 다시 직렬화하지 않는다.
function AP_getData() {
  var snap = AP_snapStr_(), jt = AP_judgeRows_(SpreadsheetApp.openById(AP.SS_A)), ids = {}, live = [];
  JSON.parse(snap).cards.forEach(function (c) { ids[c.id] = 1; });
  jt.rows.forEach(function (j) {
    if (!j.text) live.push(j); // 판정 필요: 스냅샷 뒤에 생긴 행도 카드로 보이도록 전체 필드
    else if (ids[j.id]) live.push({ id: j.id, row: j.row, text: j.text, kind: j.kind });
  });
  return '{"snap":' + snap + ',"live":' + JSON.stringify(live) + ',"at":' + JSON.stringify(AP_fmt_(new Date(), 'yyyy-MM-dd HH:mm')) + '}';
}

function AP_rebuild() { AP_buildSnapshot(60000); return AP_getData(); }

// 판정 저장. prev가 없으면 새 판정(J가 비어 있어야 함), 있으면 고치기(J가 prev와 같아야 함).
// J를 쓰면 그 행의 L~O를 비워 PL_numericize_가 30분 안에 새 판정으로 다시 숫자화한다(자동 선별값도 PD 판정으로 대체).
// '내 판정'에 없는 영상이면 PL_run과 같은 모양으로 새 행을 붙인다(선별 종류 = 문구판 직접).
function AP_save(id, text, prev) {
  id = String(id || '').trim(); text = String(text || '').trim(); prev = prev == null ? '' : String(prev).trim();
  if (!/^[\w-]{11}$/.test(id)) throw new Error('영상ID 형식이 아닙니다.');
  if (!text) throw new Error('빈 판정은 저장하지 않습니다.');
  var sh = SpreadsheetApp.openById(AP.SS_A).getSheetByName(AP.T.judge), J = AP.JUDGE;
  AP_checkJudgeHead_(sh);
  var row = AP_findJudgeRow_(sh, id);
  if (row > 0) {
    var cur = String(sh.getRange(row, J.textCol).getValue() || '').trim();
    if (prev ? cur !== prev : !!cur) return { ok: false, row: row, existing: cur };
    sh.getRange(row, J.textCol).setValue(AP_cell_(text));
    sh.getRange(row, J.numCol, 1, J.numN).clearContent();
    return { ok: true, row: row, text: text, edited: !!prev };
  }
  if (prev) throw new Error("'내 판정' 탭에서 이 영상 행이 사라졌습니다. 시트를 확인해 주세요.");
  var card = null;
  JSON.parse(AP_snapStr_()).cards.some(function (c) { if (c.id === id) { card = c; return true; } return false; });
  if (!card) throw new Error('스냅샷에 없는 영상입니다. 새로 고침 뒤 다시 저장해 주세요.');
  var lock = LockService.getScriptLock(), got = lock.tryLock(3000); // PL_run의 행 추가와 겹치지 않게(못 잡아도 진행: 대개 TO_run이 잡고 있음)
  try {
    row = Math.max(sh.getLastRow() + 1, J.head + 1);
    sh.getRange(row, 1, 1, 19).setValues([[AP_fmt_(new Date(), 'yyyy-MM-dd'), card.ch, id, '=IMAGE("https://i.ytimg.com/vi/' + id + '/mqdefault.jpg",1)', AP_cell_(card.t), AP.NEW_KIND,
      card.v == null ? '' : card.v, card.x == null ? '' : card.x, '', AP_cell_(text), '', '', '', '', '', '', '', AP_cell_(card.g || ''), AP_cell_(card.p || '')]]);
    try { if (typeof PL_fillFormulas_ === 'function') PL_fillFormulas_(sh, row, row); } catch (e) { console.log('fillFormulas: ' + e); }
    try { sh.setRowHeights(row, 1, 96); } catch (e) {}
  } finally { if (got) lock.releaseLock(); }
  if (String(sh.getRange(row, J.idCol).getValue()).trim() !== id) throw new Error("'내 판정' 새 행 확인에 실패했습니다. 시트를 확인해 주세요.");
  return { ok: true, row: row, text: text, kind: AP.NEW_KIND, appended: true };
}
function AP_findJudgeRow_(sh, id) {
  var last = sh.getLastRow(), H = AP.JUDGE.head; if (last <= H) return -1;
  var ids = sh.getRange(H + 1, AP.JUDGE.idCol, last - H, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === id) return i + H + 1;
  return -1;
}
function AP_cell_(x) { x = String(x == null ? '' : x); return /^[=+\-@]/.test(x) ? "'" + x : x; } // 수식으로 해석되지 않게(thumbCell_과 같은 처리)

// ══════════════════════════════ 스냅샷 ══════════════════════════════
function AP_buildSnapshot(clsBudgetMs) {
  var t0 = Date.now(), now = new Date(), A = SpreadsheetApp.openById(AP.SS_A), B = SpreadsheetApp.openById(AP.SS_B);
  var db = AP_table_(A.getSheetByName(AP.T.db), 1, 19);
  if (db.rows.length < 10) throw new Error('영상DB가 비어 있습니다(20시 수집 중일 수 있음). 잠시 뒤 다시 누르세요.');
  var c = AP_cols_(db.h, { at: ['갱신시각', 1], ch: ['채널', 2], id: ['영상ID', 4], t: ['제목', 6], pub: ['게시일', 7], v: ['조회수', 9], age: ['경과일', 13], x: ['채널기준배수', 15], p: ['썸네일 문구', 16] });
  var M = { th: AP_thumbs_(A), lab: AP_labels_(A), gs: AP_guests_(A), vd: AP_verdicts_(A) };
  var cards = [], seen = {}, dbById = {}, shown = {};
  var add = function (card) { if (seen[card.id]) return; seen[card.id] = 1; cards.push(card); if (card.s === 'own' || card.s === 'short') shown[card.id] = 1; };
  db.rows.forEach(function (r) {
    var id = String(r[c.id] || '').trim(); if (!id || dbById[id]) return;
    dbById[id] = r;
    var own = String(r[c.ch]) === AP.OWN, age = AP_num_(r[c.age]);
    if (own || (age !== null && age <= AP.REF_DAYS)) add(AP_dbCard_(r, c, M));
  });
  // 판정 필요(J 빈칸)인데 범위 밖인 행: 맨 위 '판정 필요'에만 보이도록 함께 싣는다(oos)
  AP_judgeRows_(A).rows.forEach(function (j) {
    if (j.text || seen[j.id]) return;
    var card = dbById[j.id] ? AP_dbCard_(dbById[j.id], c, M) : AP_judgeCard_(j, M);
    card.oos = 1; add(card);
  });
  AP_shorts_(B, now, M).forEach(add);
  var rise = AP_rise_(B, now, shown, M);
  rise.cards.forEach(add);
  var cls = AP_classify_(cards, clsBudgetMs || AP.CLS.budgetMs);
  var str = JSON.stringify({ v: 2, builtAt: AP_fmt_(now, 'yyyy-MM-dd HH:mm'), collectedAt: AP_fmt_(db.rows[0][c.at], 'yyyy-MM-dd HH:mm'),
    refDays: AP.REF_DAYS, needX: AP.NEED_X, shortsFrom: AP.SHORTS_FROM, riseMax: AP.RISE_MAX, riseNote: rise.note, cls: cls, cards: cards });
  AP_putSnap_(str);
  var n = { ref: 0, own: 0, short: 0, rise: 0 }; cards.forEach(function (x) { if (!x.oos) n[x.s]++; });
  return '레퍼런스 ' + n.ref + ' · 자사 롱폼 ' + n.own + ' · 쇼츠 ' + n.short + ' · 다시 뜨는 자사 ' + n.rise +
    ' · 자동 분류 ' + cls.auto + '(이번 ' + cls.done + ', 남음 ' + cls.left + (cls.err ? ', 오류 ' + cls.err : '') + ')' +
    ' · ' + Math.round(str.length / 1024) + 'KB · ' + ((Date.now() - t0) / 1000).toFixed(1) + '초';
}

// 영상DB 행 → 카드 (레퍼런스·자사 롱폼 공통)
function AP_dbCard_(r, c, M) {
  var id = String(r[c.id]).trim(), ch = String(r[c.ch] || ''), t = String(r[c.t] || ''), own = ch === AP.OWN, L = M.lab[id] || {}, ph = AP_phrase_(M.th[id], r[c.p]);
  return AP_decorate_({ id: id, s: own ? 'own' : 'ref', ch: ch, t: t, p: ph.p, pn: ph.n,
    pub: AP_fmt_(r[c.pub], 'yyyy-MM-dd'), age: AP_num_(r[c.age]), v: AP_num_(r[c.v]), x: AP_round_(AP_num_(r[c.x])), g: L.g || M.gs[id] || (own ? AP_titleGuest_(t) : '') }, L, M);
}
// 통합_문구DB 주간 라벨 전의 자사 신작: Pipeline.gs의 PL_guest_(제목 끝 [게스트 N부])를 그대로 쓴다
function AP_titleGuest_(t) { try { return typeof PL_guest_ === 'function' ? PL_guest_(t) : ''; } catch (e) { return ''; } }
// 영상DB에 없는(30일 지난) '내 판정' 행 → 카드
function AP_judgeCard_(j, M) {
  var L = M.lab[j.id] || {}, ph = AP_phrase_(M.th[j.id], j.p);
  return AP_decorate_({ id: j.id, s: j.ch === AP.OWN ? 'own' : 'ref', ch: j.ch, t: j.t, p: ph.p, pn: ph.n,
    pub: '', age: null, v: j.v, x: j.x, g: L.g || M.gs[j.id] || j.g }, L, M);
}
function AP_decorate_(card, L, M) {
  if (L.c1) card.c1 = L.c1; if (L.c2) card.c2 = L.c2; if (L.cl) card.cl = L.cl; if (L.ty) card.ty = L.ty;
  var v = M.vd[card.id]; if (v) { card.vd = v.v; card.vr = v.r; }
  return card;
}

// 썸네일 문구: '썸네일 문구' 탭(판독 상태 포함)이 기준, 없으면 영상DB Q열, 둘 다 없으면 '판독 대기'(화면은 유튜브 제목으로 대체)
function AP_phrase_(e, q) {
  if (e && e.st === '자동 추출 · 검수 전' && e.p) return { p: e.p, n: '' };
  if (e && e.st === '문구 없음 또는 판독 불가') return { p: '', n: '문구 없음' };
  q = AP_clean_(q);
  return q ? { p: q, n: '' } : { p: '', n: '판독 대기' };
}
// Code.gs의 thumbSummary_(꼬리표 줄 제거)를 그대로 쓴다
function AP_clean_(x) {
  x = String(x == null ? '' : x).trim(); if (!x) return '';
  try { if (typeof thumbSummary_ === 'function') x = thumbSummary_(x); } catch (e) {}
  return String(x).trim();
}
// 쇼츠는 제목 = 상단 문구(최근 통일 정책). 유튜브 제목 = 상단 1줄 + 2줄 + [게스트] 이므로 끝의 [게스트]·#태그만 뗀다
function AP_shortPhrase_(t) { return String(t || '').replace(/(\s*#\S+)+\s*$/, '').replace(/\s*\[[^\[\]]*\]\s*$/, '').trim(); }

function AP_thumbs_(A) {
  var t = AP_table_(A.getSheetByName(AP.T.th), 1, 6), c = AP_cols_(t.h, { id: ['영상ID', 0], p: ['자동 추출 문구', 4], st: ['판독 상태', 5] }), m = {};
  t.rows.forEach(function (r) { var id = String(r[c.id] || '').trim(); if (id) m[id] = { p: AP_clean_(r[c.p]), st: String(r[c.st] || '').trim() }; });
  return m;
}
// 통합_문구DB: 앱이 쓰는 열만(영상ID·영상유형·게스트명·대분류·중분류·주장). 경쟁 행이 붙으면 레퍼런스 카드에도 자동 반영(자동 분류보다 우선)
function AP_labels_(A) {
  var sh = A.getSheetByName(AP.T.lab), m = {}; if (!sh) return m;
  var t = AP_table_(sh, 1, 12), c = AP_cols_(t.h, { id: ['영상ID', 0], ty: ['영상유형', 2], g: ['게스트명', 7], c1: ['대분류', 9], c2: ['중분류', 10], cl: ['주장', 11] });
  t.rows.forEach(function (r) {
    var id = String(r[c.id] || '').trim(); if (!id) return;
    m[id] = { ty: String(r[c.ty] || '').trim(), g: String(r[c.g] || '').trim(), c1: String(r[c.c1] || '').trim(), c2: String(r[c.c2] || '').trim(), cl: String(r[c.cl] || '').trim() };
  });
  return m;
}
function AP_guests_(A) {
  var sh = A.getSheetByName(AP.T.guest), m = {}; if (!sh) return m;
  var t = AP_table_(sh, 1, 2), c = AP_cols_(t.h, { id: ['영상ID', 0], g: ['게스트', 1] });
  t.rows.forEach(function (r) { var id = String(r[c.id] || '').trim(); if (id && r[c.g]) m[id] = String(r[c.g]).trim(); });
  return m;
}
function AP_verdicts_(A) {
  var sh = A.getSheetByName(AP.T.verdict), m = {}; if (!sh) return m;
  var t = AP_table_(sh, 1, 5), c = AP_cols_(t.h, { id: ['영상ID', 0], v: ['판정', 3], r: ['근거', 4] });
  t.rows.forEach(function (r) {
    var id = String(r[c.id] || '').trim(), v = String(r[c.v] || '').trim();
    if (id && AP.WARN.indexOf(v) >= 0) m[id] = { v: v, r: String(r[c.r] || '').slice(0, 300) };
  });
  return m;
}
function AP_checkJudgeHead_(sh) {
  if (String(sh.getRange(AP.JUDGE.head, AP.JUDGE.textCol).getValue()).trim() !== AP.JUDGE.textName)
    throw new Error("'내 판정' J3 머리글이 '" + AP.JUDGE.textName + "'가 아니어서 멈췄습니다(열 구성이 바뀜).");
}
// '내 판정' 행(4행~, A~S). J가 비었으면 판정 필요.
function AP_judgeRows_(A) {
  var sh = A.getSheetByName(AP.T.judge), H = AP.JUDGE.head, last = sh.getLastRow(), out = [];
  AP_checkJudgeHead_(sh);
  if (last > H) sh.getRange(H + 1, 1, last - H, 19).getValues().forEach(function (r, i) {
    var id = String(r[2] || '').trim(); if (!id) return;
    out.push({ id: id, row: i + H + 1, text: String(r[9] || '').trim(), kind: String(r[5] || ''), reg: AP_fmt_(r[0], 'yyyy-MM-dd'),
      ch: String(r[1] || ''), t: String(r[4] || ''), v: AP_num_(r[6]), x: AP_round_(AP_num_(r[7])), g: String(r[17] || ''), p: AP_clean_(r[18]) });
  });
  return { gid: sh.getSheetId(), rows: out };
}
// 부읽남TV 콘텐츠 DB '쇼츠 참고'(매일 08:04 갱신) — 7월 1일 이후 게시분, 시트 순서를 o로 보존
function AP_shorts_(B, now, M) {
  var sh = B.getSheetByName(AP.T.shorts);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), hr = AP_headRow_(v);
  if (hr < 0) throw new Error("'쇼츠 참고' 탭에서 머리글(영상ID)을 찾지 못했습니다.");
  var c = AP_cols_(AP_headMap_(v[hr]), { pub: ['게시일', 0], t: ['제목', 4], g: ['출연자·회차', 5], v: ['조회수', 6], id: ['영상ID', 7] });
  return v.slice(hr + 1).map(function (r, i) {
    var id = String(r[c.id] || '').trim(), pub = AP_fmt_(r[c.pub], 'yyyy-MM-dd');
    if (!id || !(pub >= AP.SHORTS_FROM)) return null;
    var t = String(r[c.t] || ''), L = M.lab[id] || {};
    return AP_decorate_({ id: id, s: 'short', ch: AP.OWN, t: t, p: AP_shortPhrase_(t), pn: '', pub: pub, age: AP_age_(pub, now), v: AP_num_(r[c.v]), x: null,
      g: String(r[c.g] || '').trim() || AP_titleGuest_(t), o: i }, L, M);
  }).filter(Boolean);
}
// '급등 트렌드'(자사 전일 대비) → 다시 뜨는 자사 영상: 문구판의 자사 롱폼(1달)·쇼츠(7월~) 목록에 없는 영상을 시트 순위(급등 점수) 그대로
function AP_rise_(B, now, shown, M) {
  var sh = B.getSheetByName(AP.T.trend), out = [];
  if (!sh || sh.getLastRow() < 3) return { note: '', cards: out };
  var v = sh.getDataRange().getValues(), hr = AP_headRow_(v);
  if (hr < 0) throw new Error("'급등 트렌드' 탭에서 머리글(영상ID)을 찾지 못했습니다.");
  var c = AP_cols_(AP_headMap_(v[hr]), { rk: ['순위', 0], ty: ['유형', 1], id: ['영상ID', 2], t: ['제목', 3], pub: ['게시일', 4], v: ['오늘 조회수', 5], dv: ['증가량', 7], dr: ['증가율', 8] });
  var note = ''; // 머리글 위 안내문 중 상태 줄(예: 정상 · 09/26 / 09/25 · 1566개 비교)만
  v.slice(0, hr).forEach(function (r) { r.forEach(function (x) { if (!note && /\d+개 비교/.test(String(x))) note = String(x).trim().slice(0, 60); }); });
  v.slice(hr + 1).forEach(function (r) {
    var id = String(r[c.id] || '').trim(); if (!id || shown[id]) return;
    var t = String(r[c.t] || ''), vt = String(r[c.ty]).indexOf('쇼츠') >= 0, pub = AP_fmt_(r[c.pub], 'yyyy-MM-dd'), L = M.lab[id] || {};
    var ph = vt ? { p: AP_shortPhrase_(t), n: '' } : AP_phrase_(M.th[id], '');
    out.push(AP_decorate_({ id: id, s: 'rise', ch: AP.OWN, t: t, p: ph.p, pn: ph.n, pub: pub, age: AP_age_(pub, now), v: AP_num_(r[c.v]), x: null,
      g: L.g || M.gs[id] || AP_titleGuest_(t), vt: vt ? 1 : 0, dv: AP_num_(r[c.dv]), dr: AP_rate_(r[c.dr]), rk: AP_num_(r[c.rk]) }, L, M));
  });
  out.sort(function (a, b) { return (a.rk == null ? 1e9 : a.rk) - (b.rk == null ? 1e9 : b.rk); });
  return { note: note, cards: out.slice(0, AP.RISE_MAX) };
}

// ══════════════════════════════ 자동 대분류(표시용) ══════════════════════════════
// 통합_문구DB 라벨이 없는 카드만 PD 확정 분류표(대분류 7·중분류)로 Gemini가 분류. 결과는 '문구판 캐시' 파일 '분류' 탭에만 둔다.
function AP_classify_(cards, budgetMs) {
  var t0 = Date.now(), ss = AP_store_(true), sh = ss.getSheetByName(AP.CLS.sheet) || ss.insertSheet(AP.CLS.sheet), map = {}, todo = [], done = 0, err = '';
  if (sh.getLastRow() > 0) sh.getRange(1, 1, sh.getLastRow(), 5).getValues().forEach(function (r) { if (r[0]) map[String(r[0])] = r; });
  cards.forEach(function (c) {
    if (c.c1) return;
    var m = map[c.id];
    if (m && AP.CATS[m[1]]) { c.c1 = m[1]; if (m[2]) c.c2 = m[2]; c.ca = 1; } else todo.push(c);
  });
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key && todo.length) err = 'GEMINI_API_KEY 없음';
  for (var i = 0; key && i < todo.length && Date.now() - t0 < budgetMs; i += AP.CLS.batch) {
    var part = todo.slice(i, i + AP.CLS.batch), out;
    try { out = AP_clsCall_(part, key); } catch (e) { err = String(e && e.message || e).slice(0, 120); break; }
    var at = AP_fmt_(new Date(), 'yyyy-MM-dd HH:mm');
    (out.res || []).forEach(function (o) {
      var c = part[o && o.i]; if (!c || c.c1 || !AP.CATS[o.c1]) return;
      c.c1 = o.c1; if (AP.CATS[o.c1].indexOf(o.c2) >= 0) c.c2 = o.c2; c.ca = 1;
      map[c.id] = [c.id, c.c1, c.c2 || '', out.model, at]; done++;
    });
  }
  var keep = cards.filter(function (c) { return c.ca && map[c.id]; }).map(function (c) { return map[c.id]; }); // 지금 카드에 있는 영상만 남긴다
  sh.clearContents(); if (keep.length) sh.getRange(1, 1, keep.length, 5).setValues(keep);
  return { auto: keep.length, done: done, left: cards.filter(function (c) { return !c.c1; }).length, err: err };
}
function AP_clsPrompt_() {
  var lines = Object.keys(AP.CATS).map(function (k) {
    var d = k === '투자마인드' ? ' (종목보다 재테크 기초·마인드·저축 필요성)' : k === '라이프' ? ' (AI 활용·인간관계·다이어트·창업·자기계발 등 덜 자산적인 이야기)' : '';
    return '- ' + k + d + ': ' + AP.CATS[k].join(', ');
  });
  return ['너는 한국 경제·재테크 유튜브 영상의 주제를 분류하는 보조자다. 각 영상의 썸네일 문구와 제목만 보고 대분류 1개와 그 대분류의 중분류 1개를 고른다.',
    '분류표(PD 확정, 이 밖의 값은 쓰지 않는다):'].concat(lines).concat([
    '경계 규칙: 절세계좌 입문은 연금 맥락이면 주식>노후대비, 상품 구조 설명이면 투자마인드>재테크기초. 나스닥100은 투자 전략이면 주식>ETF, 시장 전망이면 주식>미국주식.',
    '판단이 애매해도 가장 가까운 하나를 고른다. 결과는 모든 번호에 대해 [{"i":번호,"c1":"대분류","c2":"중분류"}] JSON 배열로만 답한다.']).join('\n');
}
function AP_clsCall_(items, key) {
  var list = items.map(function (c, i) { return i + '. [' + c.ch + (c.s === 'short' || c.vt ? ' 쇼츠' : '') + '] ' + (c.p ? String(c.p).replace(/\s*\n\s*/g, ' / ') + ' || ' : '') + c.t; }).join('\n');
  var schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, c1: { type: 'STRING', enum: Object.keys(AP.CATS) }, c2: { type: 'STRING' } }, required: ['i', 'c1', 'c2'] } };
  var body = function (think) {
    var g = { temperature: 0, responseMimeType: 'application/json', responseSchema: schema };
    if (think) g.thinkingConfig = { thinkingLevel: 'low' }; // 분류는 깊은 추론이 필요 없다(50편 30초 → 수 초)
    return JSON.stringify({ contents: [{ parts: [{ text: AP_clsPrompt_() + '\n\n' + list }] }], generationConfig: g });
  };
  var last = '';
  for (var k = 0; k < AP.CLS.models.length; k++) {
    var model = AP.CLS.models[k], url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    var opt = function (think) { return { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: body(think), muteHttpExceptions: true }; };
    var res = UrlFetchApp.fetch(url, opt(true)), code = res.getResponseCode();
    if (code === 400 && /think/i.test(res.getContentText())) { res = UrlFetchApp.fetch(url, opt(false)); code = res.getResponseCode(); } // 이 설정을 모르는 모델이면 기본값으로
    if (code === 200) {
      var parts = ((((JSON.parse(res.getContentText()).candidates || [])[0] || {}).content || {}).parts) || [];
      return { model: model, res: JSON.parse(parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('') || '[]') };
    }
    last = model + ' ' + code;
    if ([404, 429, 500, 503].indexOf(code) < 0) break;
  }
  throw new Error('Gemini 분류 실패: ' + last);
}

// ══════════════════════════════ 보관 (캐시 + 별도 파일) ══════════════════════════════
function AP_snapStr_() {
  var s = AP_cacheGet_(); if (s) return s;
  s = AP_readStore_(); if (s) { AP_cachePut_(s); return s; }
  AP_buildSnapshot(AP.CLS.budgetMs); // 처음 한 번
  return AP_cacheGet_() || AP_readStore_();
}
function AP_readStore_() {
  var ss = AP_store_(false), sh = ss && ss.getSheets()[0]; if (!sh || sh.getLastRow() < 1) return '';
  return sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).slice(1); }).join('');
}
function AP_putSnap_(str) {
  AP_cachePut_(str);
  var sh = AP_store_(true).getSheets()[0], parts = [];
  for (var i = 0; i < str.length; i += AP.CELL_CHUNK) parts.push(['~' + str.slice(i, i + AP.CELL_CHUNK)]); // 앞의 ~ = 수식·숫자로 해석 방지
  sh.clearContents(); sh.getRange(1, 1, parts.length, 1).setNumberFormat('@').setValues(parts);
}
function AP_store_(create) {
  var P = PropertiesService.getScriptProperties(), id = P.getProperty(AP.PROP_STORE), ss = null;
  if (id) try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  if (!ss && create) { ss = SpreadsheetApp.create('문구판 캐시 (자동 생성 · 지우지 마세요)'); P.setProperty(AP.PROP_STORE, ss.getId()); }
  return ss;
}
function AP_cachePut_(str) {
  var m = {}, n = Math.ceil(str.length / AP.CACHE_CHUNK);
  for (var i = 0; i < n; i++) m[AP.CACHE + '_' + i] = str.slice(i * AP.CACHE_CHUNK, (i + 1) * AP.CACHE_CHUNK);
  m[AP.CACHE + '_n'] = String(n);
  try { CacheService.getScriptCache().putAll(m, 21600); } catch (e) { console.log('cache: ' + e); }
}
function AP_cacheGet_() {
  var cache = CacheService.getScriptCache(), n = +cache.get(AP.CACHE + '_n') || 0, keys = [], out = '';
  if (!n) return '';
  for (var i = 0; i < n; i++) keys.push(AP.CACHE + '_' + i);
  var m = cache.getAll(keys);
  for (var k = 0; k < n; k++) { if (m[keys[k]] == null) return ''; out += m[keys[k]]; }
  return out;
}

// ══════════════════════════════ 유틸 ══════════════════════════════
// 헤더 이름으로 열 위치를 찾되, 헤더가 비었거나 바뀌면 인계 문서의 고정 위치로
function AP_table_(sh, headRow, ncols) {
  var last = sh ? sh.getLastRow() : 0; if (last <= headRow) return { h: {}, rows: [] };
  var v = sh.getRange(headRow, 1, last - headRow + 1, Math.min(ncols, sh.getLastColumn())).getValues();
  return { h: AP_headMap_(v[0]), rows: v.slice(1) };
}
function AP_headMap_(row) { var h = {}; row.forEach(function (k, i) { k = String(k).trim(); if (k && !(k in h)) h[k] = i; }); return h; }
function AP_headRow_(v) { for (var i = 0; i < Math.min(8, v.length); i++) if (v[i].map(function (x) { return String(x).trim(); }).indexOf('영상ID') >= 0) return i; return -1; }
function AP_cols_(h, spec) { var o = {}; for (var k in spec) o[k] = (spec[k][0] in h) ? h[spec[k][0]] : spec[k][1]; return o; }
function AP_num_(x) { if (x === '' || x == null) return null; var n = typeof x === 'number' ? x : Number(String(x).replace(/[,x%\s]/g, '')); return isFinite(n) ? n : null; }
function AP_rate_(x) { if (typeof x === 'number') return x; var s = String(x || ''), n = AP_num_(s); return n === null ? null : /%/.test(s) ? n / 100 : n; }
function AP_round_(x) { return x === null ? null : Math.round(x * 1000) / 1000; }
function AP_fmt_(x, pattern) {
  if (x instanceof Date) return Utilities.formatDate(x, AP.TZ, pattern);
  return String(x == null ? '' : x).trim().slice(0, pattern.length); // 'yyyy-MM-dd…' 텍스트는 길이만 맞춘다
}
function AP_age_(pub, now) {
  if (!pub) return null;
  var d = new Date(pub + 'T00:00:00+09:00'); return isNaN(d) ? null : Math.max(0, Math.floor((now - d) / 864e5));
}
