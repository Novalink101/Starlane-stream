// 🔥 BUMPED TO V3 TO FORCE THE BROWSER TO UPDATE
const CACHE_NAME = 'forestbase-v3'; 
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/browse.html',
  '/cart.html',
  '/login.html',
  '/manifest.json'
];

// Install Event: Forces the new service worker to take over immediately
self.addEventListener('install', (event) => {
  self.skipWaiting(); 
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate Event: This is the magic that deletes the old Novalink cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // If the cache name is not the new one, delete it
          if (cacheName !== CACHE_NAME) {
            console.log('Deleted old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Tell the active service worker to take control of all pages immediately
      return self.clients.claim();
    })
  );
});

// Fetch Event: Serves files from cache, or fetches from network if not cached
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
