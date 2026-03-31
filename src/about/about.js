/**
 * Sakina — About Page
 *
 * Spiritual page with Quran aya, purpose, and dua request.
 * Fully multilingual with RTL support.
 */

import { loadTranslations, t } from '../shared/i18n.js';
import { EXTENSION_VERSION } from '../shared/constants.js';

async function init() {
  await loadTranslations();

  document.title = t('about_title');

  document.getElementById('header-version').textContent = `v${EXTENSION_VERSION}`;
  document.getElementById('aya-arabic').textContent        = t('about_quran_arabic');
  document.getElementById('aya-transliteration').textContent = t('about_quran_transliteration');
  document.getElementById('aya-translation').textContent  = t('about_quran_translation');
  document.getElementById('aya-reference').textContent    = t('about_quran_reference');
  document.getElementById('what-title').textContent       = t('about_what_title');
  document.getElementById('what-body').textContent        = t('about_what_body');
  document.getElementById('why-title').textContent        = t('about_why_title');
  document.getElementById('why-body').textContent         = t('about_why_body');
  document.getElementById('dua-title').textContent        = t('about_dua_title');
  document.getElementById('dua-body').textContent         = t('about_dua_body');
  document.getElementById('dua-arabic').textContent       = t('about_dua_arabic');
  document.getElementById('dua-meaning').textContent      = t('about_dua_arabic_meaning');
  document.getElementById('footer-brand').textContent     = t('about_footer_version');
  document.getElementById('footer-tagline').textContent   = t('about_footer_free');

  // RTL support for Arabic, Urdu, Persian
  const rtlLocales = ['ar', 'ur', 'fa'];
  const lang = (navigator.language || '').toLowerCase().split('-')[0];
  if (rtlLocales.includes(lang)) {
    document.documentElement.setAttribute('dir', 'rtl');
  }
}

document.addEventListener('DOMContentLoaded', init);
