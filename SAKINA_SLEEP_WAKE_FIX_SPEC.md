# Sakina — Sleep/Wake Fix Spec
**Version target:** 1.5.11  
**Scope:** `src/content/index.js` apenas. Duas mudanças pontuais.  
**Goal:** A extensão nunca para de funcionar após o usuário pausar um vídeo por qualquer duração.

---

## Root Cause

Quando o vídeo está pausado, `ScriptProcessorNode.onaudioprocess` para de disparar — comportamento correto. `_lastFrameTimestamp` congela no valor do último frame antes da pausa.

O watchdog verifica `!videoEl.paused` e pula a checagem enquanto pausado — também correto.

**O bug acontece no momento exato em que o usuário pressiona play:**

```
t=0s:   vídeo tocando, frames chegando, _lastFrameTimestamp = t
t=10s:  usuário pausa → onaudioprocess para → _lastFrameTimestamp congela em 10s
t=70s:  usuário pressiona play → videoEl.paused = false
t=70s:  watchdog checa: isPlaying = true, msSinceLastFrame = 70s - 10s = 60s
t=70s:  60s > 6s (threshold) → TEARDOWN → pipeline destruída
t=70.1s: primeiro frame chegaria... mas a pipeline já não existe
```

O primeiro frame após o play leva ~100ms para chegar (tempo de o `ScriptProcessorNode` reiniciar). O watchdog checa a cada 5s — se o check cair nesse gap de 100ms logo após o play, teardown acontece. Como o watchdog checa regularmente, a probabilidade é alta após pausas longas.

---

## Fix

### Mudança 1 — Adicionar listener de `play` no `startWatchdog()` (index.js)

O watchdog precisa saber quando o vídeo retoma para resetar o timestamp de referência. Quando `play` dispara, o usuário acabou de interagir — o próximo frame chegará em milissegundos. Resetar `_lastFrameTimestamp` para `Date.now()` dá ao watchdog uma janela limpa.

Adicionar variável de módulo junto às outras do watchdog:

```js
let _videoPlayHandler = null; // resets _lastFrameTimestamp on video resume
```

Em `startWatchdog()`, adicionar após `_watchdogStartTime = Date.now()`:

```js
// Reset frame timestamp when video resumes after pause.
// Without this, the watchdog sees msSinceLastFrame = pause_duration (can be minutes)
// and incorrectly tears down the pipeline the moment the user presses play.
if (_lastVideoEl && !_videoPlayHandler) {
  _videoPlayHandler = () => {
    if (_state === State.ACTIVE) {
      _lastFrameTimestamp = Date.now();
    }
  };
  _lastVideoEl.addEventListener('play', _videoPlayHandler, { passive: true });
  _lastVideoEl.addEventListener('playing', _videoPlayHandler, { passive: true });
}
```

### Mudança 2 — Limpar o listener em `stopWatchdog()` (index.js)

```js
function stopWatchdog() {
  clearInterval(_watchdogInterval);
  _watchdogInterval = null;

  // Remove play listener
  if (_videoPlayHandler && _lastVideoEl) {
    _lastVideoEl.removeEventListener('play',    _videoPlayHandler);
    _lastVideoEl.removeEventListener('playing', _videoPlayHandler);
  }
  _videoPlayHandler = null;
}
```

`stopWatchdog()` é chamado em `teardown()` — garante cleanup automático em navegação.

---

## Por que esta abordagem é correta

O `play` event dispara quando o usuário pressiona play, **antes** do primeiro frame de áudio. Ao resetar `_lastFrameTimestamp = Date.now()` nesse momento, a janela de tempo que o watchdog mede passa a ser "tempo desde que o usuário pressionou play" — não "tempo desde o último frame antes da pausa". O threshold de 6s é mais que suficiente para o primeiro frame chegar.

Isso não interfere com a detecção real de frames estagnados: se o vídeo estiver tocando e nenhum frame chegar por 6s (AudioContext stuck), o watchdog ainda detecta e reinicializa.

---

## Nada mais muda

Não alterar `AudioPipeline.js`, `MuteController.js`, `YamNetClassifier.js`, nem nenhum outro arquivo.

---

## Version bump

```js
export const EXTENSION_VERSION = '1.5.11';
```

---

## Acceptance Criteria

- [ ] Usuário pausa vídeo por 30s e pressiona play → extensão continua funcionando, sem reload
- [ ] Usuário pausa vídeo por 5 minutos e pressiona play → extensão continua funcionando, sem reload
- [ ] Se AudioContext realmente travar com vídeo tocando → watchdog ainda detecta e reinicializa (6s threshold mantido)
- [ ] Navegar para outro vídeo → listeners removidos corretamente (sem memory leak)
