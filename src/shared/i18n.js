/**
 * Sakina — i18n helper
 *
 * chrome.i18n.getMessage() só funciona com o idioma da UI do Chrome,
 * que no macOS/Windows reflete o idioma do SO, não das preferências.
 *
 * Este módulo carrega o messages.json manualmente via fetch()
 * baseado em navigator.language, garantindo tradução correta
 * independente do idioma do sistema operacional.
 */

const SUPPORTED_LOCALES = ['ar', 'bn', 'fa', 'fr', 'id', 'ms', 'pt', 'tr', 'ur', 'en'];

let _cache = null;

function detectLocale() {
  const candidates = [
    ...(navigator.languages || []),
    navigator.language || '',
  ].filter(Boolean).map(l => l.toLowerCase().split('-')[0]);

  for (const lang of candidates) {
    if (SUPPORTED_LOCALES.includes(lang)) return lang;
  }
  return 'en';
}

export async function loadTranslations() {
  if (_cache) return;

  const locale = detectLocale();

  const tryLoad = async (loc) => {
    const url = chrome.runtime.getURL(`_locales/${loc}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v.message || ''])
    );
  };

  try {
    _cache = await tryLoad(locale);
    console.info(`[Sakina:i18n] Loaded locale: ${locale}`);
  } catch (err) {
    console.warn(`[Sakina:i18n] Failed "${locale}", trying "en"`, err);
    try {
      _cache = await tryLoad('en');
      console.info('[Sakina:i18n] Loaded fallback locale: en');
    } catch {
      _cache = {};
      console.error('[Sakina:i18n] Failed to load any locale');
    }
  }
}

/**
 * IMPORTANTE: cache manual tem prioridade sobre chrome.i18n.
 * chrome.i18n usa o idioma do SO, não de navigator.language.
 */
export function t(key) {
  if (_cache?.[key]) return _cache[key];
  const native = chrome.i18n.getMessage(key);
  if (native) return native;
  return key;
}
