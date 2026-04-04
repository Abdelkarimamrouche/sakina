# Sakina — Rename completo de MusicShield → Sakina

## Contexto

O nome "MusicShield" tem muitos conflitos com produtos existentes. O novo nome é **Sakina** (سكينة) — palavra árabe que significa tranquilidade e paz do coração, mencionada no Quran. É único, memorável e conectado ao propósito islâmico da extensão.

---

## Regras de substituição

| Onde aparece | Antes | Depois |
|---|---|---|
| Nome de exibição | MusicShield | Sakina |
| Nome técnico/package | music-shield | sakina |
| Logs do console | [MusicShield] | [Sakina] |
| Comentários de arquivo | MusicShield — | Sakina — |
| Título do browser | MusicShield | Sakina |
| brand-name no popup | MusicShield | Sakina |

---

## Arquivo 1 — `manifest.json`

```json
{
  "name": "__MSG_ext_name__",
  "short_name": "Sakina",
  "version": "1.3.0",
  "description": "__MSG_ext_description__"
}
```

> O `name` e `description` já vêm dos `_locales` via `__MSG_*__` — não alterar essas chaves, só o `short_name`.

---

## Arquivo 2 — `package.json`

```json
{
  "name": "sakina",
  "description": "Sakina — auto mute music extension for the Muslim community"
}
```

---

## Arquivo 3 — `src/shared/constants.js`

Atualizar o comentário do arquivo e a versão:

```js
/**
 * Sakina — Shared Constants
 */

export const EXTENSION_VERSION = '1.3.0';
```

---

## Arquivo 4 — `src/popup/popup.js`

**a) Comentário do arquivo:**
```js
/**
 * Sakina — Popup UI (i18n)
 */
```

**b) Brand name no HTML gerado:**
```js
// ANTES
<span class="brand-name">MusicShield</span>

// DEPOIS
<span class="brand-name">Sakina</span>
```

**c) Todos os console.log/warn/error — substituição global:**
```
[MusicShield] → [Sakina]
[MusicShield: → [Sakina:
```

---

## Arquivo 5 — `src/popup/index.html`

```html
<title>Sakina</title>
```

---

## Arquivo 6 — `src/popup/popup.css`

```css
/* Sakina Popup — Dark UI */
```

---

## Arquivo 7 — `src/options/index.html`

**a) Title:**
```html
<title>Sakina — Settings</title>
```

**b) h1:**
```html
<h1>Sakina</h1>
```

**c) Welcome banner (hardcoded — substituir até o i18n cobrir):**
```html
<h2>Welcome to Sakina 👋</h2>
<p>Your preferences are saved automatically. Open any YouTube video — Sakina will load the AI model the first time (~5 seconds), then run fully offline from that point forward.</p>
```

**d) Enable toggle label:**
```html
<div class="row-label">Enable Sakina</div>
```

---

## Arquivo 8 — `src/options/options.js`

```js
/**
 * Sakina — Options Page (i18n)
 */
```

---

## Arquivo 9 — `src/content/index.js`

Substituição global de todos os console logs:
```
[MusicShield] → [Sakina]
[MusicShield: → [Sakina:
```

Comentário do arquivo:
```js
/**
 * Sakina — Content Script
 */
```

---

## Arquivo 10 — `src/content/AudioPipeline.js`

```js
/**
 * Sakina — AudioPipeline
 */
```

Logs:
```
[MusicShield:pipeline] → [Sakina:pipeline]
```

---

## Arquivo 11 — `src/content/MuteController.js`

```js
/**
 * Sakina — MuteController
 */
```

Logs:
```
[MusicShield:controller] → [Sakina:controller]
```

---

## Arquivo 12 — `src/content/YamNetClassifier.js`

```js
/**
 * Sakina — YamNetClassifier
 */
```

Logs:
```
[MusicShield:yamnet] → [Sakina:yamnet]
```

---

## Arquivo 13 — `src/content/platforms.js`

```js
/**
 * Sakina — Platform Adapters
 */
```

---

## Arquivo 14 — `src/background/service-worker.js`

```js
/**
 * Sakina — Background Service Worker (Manifest V3)
 */
```

Logs:
```
[MusicShield:bg] → [Sakina:bg]
```

---

## Arquivo 15 — `src/shared/storage.js`

```js
/**
 * Sakina — Storage Module
 */
```

Logs:
```
[MusicShield:storage] → [Sakina:storage]
```

---

## Arquivo 16 — `src/shared/i18n.js`

```js
/**
 * Sakina — i18n helper
 */
```

Logs:
```
[MusicShield:i18n] → [Sakina:i18n]
```

---

## Arquivo 17 — `_locales/*/messages.json` — todas as 10 línguas

Atualizar as chaves que contêm o nome visível ao usuário:

### `ext_name` — cada idioma:
```json
"ext_name": { "message": "Sakina — Auto Mute Music" }
```

### `ext_short_name`:
```json
"ext_short_name": { "message": "Sakina" }
```

### `ext_description` — cada idioma (manter a tradução, só trocar o nome):
- **en:** `"Sakina automatically detects and mutes music on YouTube, Instagram, Facebook and TikTok using on-device AI. Speech and ambient sounds play normally."`
- **pt:** `"Sakina detecta e silencia automaticamente músicas no YouTube, Instagram, Facebook e TikTok usando IA. Voz e sons ambientes continuam normalmente."`
- **ar:** `"Sakina يكشف الموسيقى ويكتمها تلقائياً في يوتيوب وإنستغرام وفيسبوك وتيك توك باستخدام الذكاء الاصطناعي."`
- **id:** `"Sakina otomatis mendeteksi dan membisukan musik di YouTube, Instagram, Facebook, dan TikTok menggunakan AI."`
- **tr:** `"Sakina, YouTube, Instagram, Facebook ve TikTok'taki müziği yapay zeka kullanarak otomatik olarak algılar ve susturur."`
- **fr:** `"Sakina détecte et coupe automatiquement la musique sur YouTube, Instagram, Facebook et TikTok grâce à l'IA."`
- **ms:** `"Sakina mengesan dan meredamkan muzik secara automatik di YouTube, Instagram, Facebook dan TikTok menggunakan AI."`
- **bn:** `"Sakina AI ব্যবহার করে YouTube, Instagram, Facebook ও TikTok-এ সঙ্গীত স্বয়ংক্রিয়ভাবে শনাক্ত করে নিঃশব্দ করে।"`
- **fa:** `"Sakina با هوش مصنوعی، موسیقی را در YouTube، Instagram، Facebook و TikTok خاموش می‌کند."`
- **ur:** `"Sakina AI کے ذریعے YouTube، Instagram، Facebook اور TikTok پر موسیقی خودکار خاموش کرتا ہے۔"`

### Chaves com "MusicShield" explícito — substituir em todos os locales:

Procurar e substituir em todos os `messages.json`:
```
"MusicShield" → "Sakina"
```

Isso cobre chaves como:
- `toggle_enable`: "Enable MusicShield" → "Enable Sakina"  
- `toggle_disable`: "Disable MusicShield" → "Disable Sakina"
- `opt_enable_label`: "Enable MusicShield" → "Enable Sakina"
- `about_title`: "About MusicShield" → "About Sakina"
- `about_what_title`: "What is MusicShield?" → "What is Sakina?"
- `about_footer_version`: "MusicShield" → "Sakina"
- `opt_welcome_title`: "Welcome to MusicShield 👋" → "Welcome to Sakina 👋"
- E todas as outras ocorrências

---

## Arquivo 18 — `src/__tests__/*.test.js` (opcional)

Atualizar comentários apenas:
```
MusicShield — Tests → Sakina — Tests
```

---

## Comando para encontrar ocorrências restantes

Após aplicar todas as mudanças, rodar para garantir que não ficou nada para trás:

```bash
grep -rn "MusicShield\|music-shield\|musicshield" src/ _locales/ manifest.json package.json \
  --include="*.js" --include="*.html" --include="*.css" --include="*.json" \
  | grep -v "node_modules"
```

Não deve retornar nenhum resultado.

---

## Build final

```bash
npm run build
```

Verificar:
- `dist/popup.html` → title "Sakina"
- `dist/_locales/en/messages.json` → `ext_name`: "Sakina — Auto Mute Music"
- Popup abre com "Sakina" no header
- Options page mostra "Sakina Settings"

---

## NÃO modificar

- Lógica de áudio (`AudioPipeline.js`, `YamNetClassifier.js`, `MuteController.js`) — só os comentários
- `webpack.config.js` — não precisa de alteração
- Assets (`icons/`, `yamnet/`) — não precisam de alteração
