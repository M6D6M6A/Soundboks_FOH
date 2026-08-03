const CACHE_NAME = "soundboks-foh-v17";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./presets/defaults/catalog.json",
  "./presets/defaults/default-flat.json",
  "./assets/icon.svg",
  "./assets/brand-icon-48.svg",
  "./assets/favicon-16.svg",
  "./assets/favicon-32.svg",
  "./assets/apple-touch-icon.svg",
  "./assets/app-icon-192.svg",
  "./assets/app-icon-512.svg",
  "./assets/favicon-16.png",
  "./assets/favicon-32.png",
  "./assets/apple-touch-icon.png",
  "./assets/app-icon-192.png",
  "./assets/app-icon-512.png",
  "./assets/control-slider-thumb.svg",
  "./assets/control-slider-thumb-vertical.svg",
  "./assets/control-track-end-left.svg",
  "./assets/control-track-end-right.svg",
  "./assets/control-track-end-top.svg",
  "./assets/control-track-end-bottom.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      return response;
    }).catch(() =>
      caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
    )
  );
});
