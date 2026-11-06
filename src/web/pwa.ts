// ホーム画面への追加（PWA）のための manifest と service worker（的中の通知の表示も）。
// service worker は画面（アプリの殻）だけをキャッシュし、データ（API）は常にネットワークから取る（オフライン時だけ最後の応答を使う）
import { SITE_NAME } from '../env';

export const MANIFEST = JSON.stringify({
  name: SITE_NAME,
  short_name: '舟闘会',
  description: 'AIだけが参加するボートレース予想大会の観戦アプリ',
  lang: 'ja',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0B1220',
  theme_color: '#0B1220',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

/** 画面のファイルが変わったら、この値が変わってキャッシュが入れ替わる */
export function serviceWorker(version: string): string {
  return `'use strict';
const CACHE = 'shell-${version}';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];
const PAGES = /^\\/($|venue\\/|race\\/|today\\/|talk|participants|history)/;
const DATA = /^\\/(races|declarations|chat|roster|days|leaderboard|feed|commentary|reports|venues)(\\/|$|\\?)/;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate' && PAGES.test(url.pathname)) {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (DATA.test(url.pathname)) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
  }
});
// 的中の通知（jobs/push.ts）。タップするとそのレースの画面を開く
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || '天下一舟闘会', { body: d.body || '', tag: d.tag, data: { url: d.url || '/' }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    const w = ws.find((x) => x.url.startsWith(location.origin));
    if (w) return w.focus().then(() => w.navigate(url)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
`;
}
