/**
 * Sakina — Platform Adapters
 *
 * Each platform has its own SPA navigation pattern, video element
 * selectors, and container structure. This module centralises all
 * platform-specific knowledge so index.js stays generic.
 *
 * Supported platforms:
 *   - YouTube  (youtube.com, music.youtube.com)
 *   - Instagram (instagram.com)
 *   - Facebook  (facebook.com, fb.watch)
 *   - TikTok   (tiktok.com)
 */

// ─── Platform Definitions ─────────────────────────────────────────────────────

const PLATFORMS = {
  // ── YouTube ────────────────────────────────────────────────────────────────
  youtube: {
    name: 'YouTube',

    matches(hostname) {
      return hostname === 'www.youtube.com' ||
             hostname === 'youtube.com' ||
             hostname === 'music.youtube.com';
    },

    /**
     * Only process watch pages and Shorts — skip the home feed,
     * search results, etc. (no video to classify there).
     */
    isVideoPage() {
      return (location.pathname === '/watch' && location.search.includes('v=')) ||
              location.pathname.startsWith('/shorts/');
    },

    /**
     * YouTube exposes custom events when its SPA router finishes navigation.
     */
    setupNavigation(onNavigate) {
      document.addEventListener('yt-navigate-finish', onNavigate);
      document.addEventListener('yt-page-data-updated', onNavigate);
      return () => {
        document.removeEventListener('yt-navigate-finish', onNavigate);
        document.removeEventListener('yt-page-data-updated', onNavigate);
      };
    },

    /** YouTube's main player video element has a stable class. */
    videoSelector: 'video.html5-main-video',

    /** Container that holds the player — watched for element swaps. */
    playerContainerSelector: '#movie_player',
  },

  // ── Instagram ──────────────────────────────────────────────────────────────
  instagram: {
    name: 'Instagram',

    matches(hostname) {
      return hostname === 'www.instagram.com' || hostname === 'instagram.com';
    },

    /**
     * All Instagram pages can show videos (feed, Reels, Stories, profile).
     * We keep it permissive and let the video detector decide.
     */
    isVideoPage() {
      return true;
    },

    /**
     * Instagram is a React SPA. It uses the History API — we listen to
     * popstate AND patch pushState/replaceState to catch programmatic navs.
     */
    setupNavigation(onNavigate) {
      const handlePop = () => onNavigate();
      window.addEventListener('popstate', handlePop);

      // Patch History API so we catch pushState-driven navigations too.
      const originalPush    = history.pushState.bind(history);
      const originalReplace = history.replaceState.bind(history);

      history.pushState = (...args) => {
        originalPush(...args);
        onNavigate();
      };
      history.replaceState = (...args) => {
        originalReplace(...args);
        onNavigate();
      };

      return () => {
        window.removeEventListener('popstate', handlePop);
        history.pushState    = originalPush;
        history.replaceState = originalReplace;
      };
    },

    videoSelector: 'video',
    playerContainerSelector: 'main',
  },

  // ── Facebook ───────────────────────────────────────────────────────────────
  facebook: {
    name: 'Facebook',

    matches(hostname) {
      return hostname === 'www.facebook.com' ||
             hostname === 'web.facebook.com' ||
             hostname === 'facebook.com' ||
             hostname === 'fb.watch';
    },

    isVideoPage() {
      const path = location.pathname;
      // /watch, /reel/, /videos/, /stories/ and any post page can have video.
      return path.startsWith('/watch') ||
             path.includes('/reel/') ||
             path.includes('/videos/') ||
             path.includes('/stories/') ||
             path === '/';           // feed — Reels and video posts appear here
    },

    setupNavigation(onNavigate) {
      const handlePop = () => onNavigate();
      window.addEventListener('popstate', handlePop);

      const originalPush    = history.pushState.bind(history);
      const originalReplace = history.replaceState.bind(history);

      history.pushState = (...args) => {
        originalPush(...args);
        onNavigate();
      };
      history.replaceState = (...args) => {
        originalReplace(...args);
        onNavigate();
      };

      return () => {
        window.removeEventListener('popstate', handlePop);
        history.pushState    = originalPush;
        history.replaceState = originalReplace;
      };
    },

    videoSelector: 'video',
    playerContainerSelector: '[role="main"]',
  },

  // ── TikTok ─────────────────────────────────────────────────────────────────
  tiktok: {
    name: 'TikTok',

    matches(hostname) {
      return hostname === 'www.tiktok.com' || hostname === 'tiktok.com';
    },

    isVideoPage() {
      const path = location.pathname;
      // Video pages: /@user/video/123, /foryou, /following, /explore, /live
      return path.includes('/video/') ||
             path === '/' ||
             path === '/foryou' ||
             path === '/following' ||
             path === '/explore' ||
             path.includes('/live');
    },

    setupNavigation(onNavigate) {
      const handlePop = () => onNavigate();
      window.addEventListener('popstate', handlePop);

      const originalPush    = history.pushState.bind(history);
      const originalReplace = history.replaceState.bind(history);

      history.pushState = (...args) => {
        originalPush(...args);
        onNavigate();
      };
      history.replaceState = (...args) => {
        originalReplace(...args);
        onNavigate();
      };

      return () => {
        window.removeEventListener('popstate', handlePop);
        history.pushState    = originalPush;
        history.replaceState = originalReplace;
      };
    },

    videoSelector: 'video',
    playerContainerSelector: '#app',
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect which platform adapter matches the current page.
 * Returns null if the hostname is not supported.
 *
 * @returns {object|null}
 */
export function detectPlatform() {
  const hostname = location.hostname;
  return Object.values(PLATFORMS).find(p => p.matches(hostname)) ?? null;
}

/**
 * Given a platform adapter, find the best <video> element to classify.
 *
 * For YouTube we use its stable class selector. For other platforms we
 * fall back to a heuristic: find all <video> elements that are actually
 * playing (or have a source) and pick the one with the largest visible area.
 *
 * @param {object} platform
 * @returns {HTMLVideoElement|null}
 */
export function findBestVideo(platform) {
  // YouTube has a deterministic selector — use it directly.
  if (platform.videoSelector !== 'video') {
    return document.querySelector(platform.videoSelector);
  }

  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;

  // Prefer a video that is currently playing.
  const playing = videos.filter(v => !v.paused && !v.ended && v.readyState >= 2);
  const candidates = playing.length > 0 ? playing : videos.filter(v => v.readyState >= 1);
  if (candidates.length === 0) return null;

  // Among candidates, pick the one with the largest visible bounding box.
  return candidates.reduce((best, v) => {
    const r = v.getBoundingClientRect();
    const bestR = best.getBoundingClientRect();
    return (r.width * r.height) > (bestR.width * bestR.height) ? v : best;
  });
}

/**
 * Wait for a suitable video element to appear on the page.
 * Uses MutationObserver + periodic checks (handles lazy-rendered players).
 *
 * @param {object} platform
 * @param {number} timeout  - Max wait in ms
 * @returns {Promise<HTMLVideoElement|null>}
 */
export function waitForVideo(platform, timeout = 10000) {
  return new Promise((resolve) => {
    // Check immediately.
    const immediate = findBestVideo(platform);
    if (immediate) {
      resolve(immediate);
      return;
    }

    const container = document.querySelector(platform.playerContainerSelector) ?? document.body;

    const observer = new MutationObserver(() => {
      const el = findBestVideo(platform);
      if (el) {
        observer.disconnect();
        clearTimeout(handle);
        resolve(el);
      }
    });

    observer.observe(container, { childList: true, subtree: true });

    const handle = setTimeout(() => {
      observer.disconnect();
      // One last attempt before giving up.
      resolve(findBestVideo(platform));
    }, timeout);
  });
}
