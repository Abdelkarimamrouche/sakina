# Sakina — Brave Browser Compatibility Fix Spec
**Version target:** 1.5.12  
**Scope:** `src/content/AudioPipeline.js` e `src/content/index.js`. Mudanças cirúrgicas.  
**Goal:** A extensão funciona no Brave sem reload, com os Shields ativados.

---

## Diferenças do Brave que causam o problema

### Diferença 1 — `AudioContext.resume()` resolve sem o contexto ficar `running`

No Brave com Shields ativos, `ctx.resume()` pode retornar `Promise.resolve()` mas `ctx.state` continuar `'suspended'`. O gesture handler atual confia em `ctx.state === 'running'` para saber se funcionou:

```js
this._ctx.resume().then(() => {
  if (this._ctx?.state === 'running') {  // Brave: pode ser false mesmo aqui
    this._removeGestureListeners();       // listeners removidos prematuramente
  }
});
```

Resultado: listeners removidos, AudioContext ainda suspended, sem mais recovery.

### Diferença 2 — Política de User Activation mais restritiva

Brave exige que o gesto de "user activation" seja mais próximo temporalmente da chamada de `resume()`. Um scroll no topo da página enquanto o AudioContext está há muito tempo em suspended pode não ser aceito como activation válida.

### Diferença 3 — `onstatechange` pode não disparar

Em algumas versões do Brave/Chromium, `onstatechange` não dispara quando o contexto transiciona de `suspended` para `running` após `resume()`. O handler de recovery que depende desse evento não funciona.

---

## Fix

### Mudança 1 — Validação por frames, não por `ctx.state` (AudioPipeline.js)

A única confirmação confiável de que o AudioContext está funcionando é que `onaudioprocess` está disparando. Em vez de confiar em `ctx.state`, o gesture handler deve aguardar frames reais antes de se remover.

Adicionar campo ao constructor:
```js
/** @type {function|null} Called when first audio frame arrives — signals AudioContext is truly running */
this._onFirstFrameCallback = null;
```

Substituir o bloco do gesture handler em `initialize()`:

**Antes:**
```js
if (this._ctx.state === 'suspended') {
  const tryResume = () => {
    if (!this._ctx) { this._removeGestureListeners(); return; }
    if (this._ctx.state === 'running') { this._removeGestureListeners(); return; }
    this._ctx.resume().then(() => {
      if (this._ctx?.state === 'running') {
        this._removeGestureListeners();
      }
    }).catch(() => {});
  };
  this._gestureHandler = tryResume;
  document.addEventListener('click',      tryResume, { passive: true });
  document.addEventListener('keydown',    tryResume, { passive: true });
  document.addEventListener('scroll',     tryResume, { passive: true });
  document.addEventListener('touchstart', tryResume, { passive: true });
}
```

**Depois:**
```js
// Register gesture listeners whenever context is suspended.
// Brave: ctx.resume() may resolve without ctx.state becoming 'running'.
// We do NOT rely on ctx.state for cleanup — instead, we remove listeners
// only when the first real audio frame arrives (confirmed in _onAudioProcess).
this._registerGestureListeners();
```

Adicionar o método `_registerGestureListeners()` à classe:
```js
_registerGestureListeners() {
  // Remove any existing listeners first (prevent duplicates on re-registration)
  this._removeGestureListeners();

  const tryResume = () => {
    if (!this._ctx) { this._removeGestureListeners(); return; }
    // Try to resume regardless of reported state — Brave may lie about state
    this._ctx.resume().catch(() => {});
  };

  this._gestureHandler = tryResume;
  document.addEventListener('click',      tryResume, { passive: true });
  document.addEventListener('keydown',    tryResume, { passive: true });
  document.addEventListener('scroll',     tryResume, { passive: true });
  document.addEventListener('touchstart', tryResume, { passive: true });
}
```

Modificar `_onAudioProcess()` para remover os gesture listeners no primeiro frame real:
```js
_onAudioProcess(event) {
  // First real frame = AudioContext is confirmed running — safe to remove gesture listeners
  // This is the only reliable signal across Chrome, Brave, and other Chromium variants.
  if (this._gestureHandler) {
    this._removeGestureListeners();
  }

  // ... resto do método não muda ...
  const channelData = event.inputBuffer.getChannelData(0);
  // ...
}
```

Modificar `onstatechange` para re-registrar listeners quando contexto volta a suspended:
```js
this._ctx.onstatechange = () => {
  if (this._ctx.state === 'suspended') {
    // Context became suspended again (tab switch, Brave policy) — re-register gesture listeners
    this._ctx.resume().catch(() => {});
    this._registerGestureListeners();
  }
  // Note: no cleanup on 'running' — cleanup happens when first frame arrives
};
```

Remover o check `if (this._ctx.state === 'suspended')` antes do `_registerGestureListeners()` em `initialize()` — registrar sempre, independente do estado inicial. Se o contexto já estiver running, os listeners serão removidos no primeiro frame de qualquer forma.

---

### Mudança 2 — Watchdog re-registra gesture listeners se contexto ainda suspended (index.js)

Se o watchdog detectar que o AudioContext está suspended E nenhum frame chegou, em vez de fazer teardown/setup (que não resolve no Brave), tenta re-registrar os listeners:

Em `startWatchdog()`, modificar o bloco de detecção:

**Antes:**
```js
const ctxSuspended = _pipeline?._ctx?.state === 'suspended';
const effectiveThreshold = (_lastFrameTimestamp === 0 && ctxSuspended)
  ? 30_000
  : WATCHDOG_STALE_THRESHOLD;

if (msSinceLastFrame > effectiveThreshold) {
  console.warn(`[Sakina] Watchdog: no audio frame for ${msSinceLastFrame}ms — reinitializing pipeline`);
  await teardown();
  setTimeout(setup, 200);
}
```

**Depois:**
```js
const ctxSuspended = _pipeline?._ctx?.state === 'suspended';
const effectiveThreshold = (_lastFrameTimestamp === 0 && ctxSuspended)
  ? 30_000
  : WATCHDOG_STALE_THRESHOLD;

if (msSinceLastFrame > effectiveThreshold) {
  if (ctxSuspended && _lastFrameTimestamp === 0) {
    // AudioContext is suspended and no frames have ever arrived.
    // Brave may silently block resume() — re-register gesture listeners
    // and retry resume() without full teardown. This avoids the infinite
    // teardown/setup cycle that doesn't help in Brave.
    console.warn(`[Sakina] Watchdog: AudioContext still suspended after ${msSinceLastFrame}ms — retrying resume`);
    _pipeline?._ctx?.resume().catch(() => {});
    _pipeline?._registerGestureListeners();
    // Reset watchdog start time to give another full grace period
    _watchdogStartTime = Date.now();
  } else {
    // Frames were arriving but stopped — real stale condition, full reinit
    console.warn(`[Sakina] Watchdog: no audio frame for ${msSinceLastFrame}ms — reinitializing pipeline`);
    await teardown();
    setTimeout(setup, 200);
  }
}
```

---

## Por que esta abordagem funciona no Brave

1. **Gesture listeners nunca são removidos prematuramente** — só se removem quando o primeiro frame real chega, não quando `ctx.state` muda (que no Brave pode ser falso positivo ou nunca acontecer).

2. **Re-registro automático** — sempre que `onstatechange` detecta `suspended`, re-registra. Sempre que o watchdog detecta nenhum frame após grace period, re-registra + retenta `resume()`.

3. **Sem teardown desnecessário** — quando o problema é apenas o AudioContext suspended (nunca houve frames), o watchdog tenta resolver no lugar, sem destruir e recriar a pipeline.

4. **Funciona em ambos** — no Chrome, `ctx.state` vai para `running` rapidamente e `_onAudioProcess` dispara em seguida. No Brave, `ctx.state` pode ser inconsistente mas `_onAudioProcess` é sempre confiável quando o áudio realmente flui.

---

## Nada mais muda

Não alterar `MuteController.js`, `YamNetClassifier.js`, `UnmuteBadge.js`, `platforms.js`, ou qualquer arquivo de UI.

---

## Version bump

```js
export const EXTENSION_VERSION = '1.5.12';
```

---

## Acceptance Criteria

- [ ] Brave com Shields ativados: extensão começa a classificar após primeiro scroll ou clique, sem reload
- [ ] Brave com Shields desativados: comportamento idêntico ao Chrome
- [ ] Chrome: comportamento não regride — funciona como antes
- [ ] Gesture listeners não acumulam (sem duplicatas) — cada `_registerGestureListeners()` remove os anteriores primeiro
- [ ] Watchdog não faz teardown quando o único problema é AudioContext suspended no Brave
- [ ] Após trocar de aba e voltar no Brave: `onstatechange` → `_registerGestureListeners()` → próximo scroll resume
