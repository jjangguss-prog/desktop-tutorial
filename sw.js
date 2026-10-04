// 한 번 연 본문과 화면은 저장해 두었다가 인터넷이 약할 때도 열리게 한다.
// (음성 인식 자체는 브라우저가 인터넷으로 처리하므로 연결이 필요하다.)
const CACHE = 'bible-reader-v3';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/books.js',
  'js/mcheyne.js',
  'js/matcher.js',
  'js/plans.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return;

  // 성경 본문과 글꼴은 바뀌지 않으니 저장본을 먼저 쓴다.
  if (isFont || url.pathname.includes('/data/books/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // 화면 파일은 새 버전을 먼저 받아 보고, 안 되면 저장본을 쓴다.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
