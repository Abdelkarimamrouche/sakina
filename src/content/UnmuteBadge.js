/**
 * Sakina — UnmuteBadge
 *
 * Floating overlay that appears when Sakina mutes audio.
 * Gives the user one-click session override and long-press permanent allowlist.
 */

const LONG_PRESS_DURATION = 2000; // 2 seconds
const MIN_DISPLAY_MS = 2500; // badge stays visible for at least 2.5s after appearing
const STYLE_ID = 'skn-badge-styles';

// Build muted speaker icon using DOM API — no innerHTML (YouTube Trusted Types policy)
function buildMutedIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');

  const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l1.setAttribute('x1', '23'); l1.setAttribute('y1', '9');
  l1.setAttribute('x2', '17'); l1.setAttribute('y2', '15');

  const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l2.setAttribute('x1', '17'); l2.setAttribute('y1', '9');
  l2.setAttribute('x2', '23'); l2.setAttribute('y2', '15');

  svg.appendChild(poly);
  svg.appendChild(l1);
  svg.appendChild(l2);
  return svg;
}

// CSS styles for the badge (scoped with skn- prefix)
// Bug C fix: removed opacity/transform/transition from CSS — now controlled via inline styles
const BADGE_STYLES = `
.skn-badge {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px 7px 10px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}

.skn-badge:hover {
  background: rgba(0, 0, 0, 0.85);
  border-color: rgba(255, 255, 255, 0.2);
}

.skn-badge-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.skn-badge-text {
  white-space: nowrap;
}

.skn-badge-ring {
  position: absolute;
  top: -3px;
  left: -3px;
  right: -3px;
  bottom: -3px;
  pointer-events: none;
}

.skn-badge-ring circle {
  fill: none;
  stroke: #22c55e;
  stroke-width: 3;
  stroke-linecap: round;
}

.skn-confirmation {
  position: fixed;
  z-index: 2147483647;
  padding: 8px 16px;
  background: rgba(34, 197, 94, 0.9);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 999px;
  color: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
}

@media (max-width: 600px) {
  .skn-badge,
  .skn-confirmation {
    font-size: 12px;
    padding: 6px 12px 6px 8px;
  }
}
`;

export class UnmuteBadge {
  /**
   * @param {object} options
   * @param {function} options.onSessionUnmute   — called when user clicks (session override)
   * @param {function} options.onAllowlist        — called when user long-presses (permanent)
   * @param {function(): HTMLElement} options.getPlayerContainer — returns the player DOM element to anchor the badge
   */
  constructor(options) {
    this._onSessionUnmute = options.onSessionUnmute;
    this._onAllowlist = options.onAllowlist;
    this._getPlayerContainer = options.getPlayerContainer;

    this._badge = null;
    this._confirmation = null;
    this._ringCircle = null;
    this._isVisible = false;

    // Long press state
    this._pressStartTime = null;
    this._longPressTimer = null;
    this._rafId = null;

    // Bug B fix: minimum display timer
    this._minDisplayTimer = null;
    this._hidePending = false; // hide() foi chamado durante o min display timer

    // Event listener references for cleanup
    this._boundHandlers = {
      pointerDown: this._onPointerDown.bind(this),
      pointerUp: this._onPointerUp.bind(this),
      pointerLeave: this._onPointerLeave.bind(this),
      click: this._onClick.bind(this),
      resize: this._debounce(this._updatePosition.bind(this), 100),
      fullscreenChange: this._updatePosition.bind(this),
    };

    this._injectStyles();
    this._createBadge();
    this._createConfirmation();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /** Show the badge. Animates in. */
  show() {
    if (this._isVisible) return;
    this._hidePending = false; // reset — nova exibição cancela qualquer hide pendente
    this._isVisible = true;

    this._updatePosition();

    // Bug C fix: Reveal via inline styles — immune to YouTube's CSS cascade
    void this._badge.offsetWidth; // force reflow before changing transition target
    Object.assign(this._badge.style, {
      opacity: '1',
      transform: 'translateY(0)',
      pointerEvents: 'auto',
    });

    // Bug B fix: Enforce minimum display time — prevents flash-and-disappear
    clearTimeout(this._minDisplayTimer);
    this._minDisplayTimer = setTimeout(() => {
      this._minDisplayTimer = null;
      if (this._hidePending) {
        this._hidePending = false;
        this.hide();
      }
    }, MIN_DISPLAY_MS);

    window.addEventListener('resize', this._boundHandlers.resize);
    document.addEventListener('fullscreenchange', this._boundHandlers.fullscreenChange);
  }

  /** Hide the badge. Animates out, then removes from DOM. */
  hide() {
    if (!this._isVisible) return;

    // Bug B fix: Don't hide if minimum display time hasn't elapsed
    if (this._minDisplayTimer) {
      this._hidePending = true; // executar hide() quando o timer expirar
      return;
    }
    this._hidePending = false;

    this._isVisible = false;
    this._cancelLongPress();

    // Bug C fix: Hide via inline styles
    Object.assign(this._badge.style, {
      transition: 'opacity 150ms ease-in',
      opacity: '0',
      pointerEvents: 'none',
    });

    window.removeEventListener('resize', this._boundHandlers.resize);
    document.removeEventListener('fullscreenchange', this._boundHandlers.fullscreenChange);

    // Reset transform and transition for next show()
    setTimeout(() => {
      if (!this._isVisible) {
        Object.assign(this._badge.style, {
          transform: 'translateY(6px)',
          transition: 'opacity 200ms ease-out, transform 200ms ease-out',
        });
      }
    }, 150);
  }

  /** Update the confirmation message (brief label shown after action). */
  showConfirmation(message) {
    // Bug B fix: Force hide even if minimum display timer is active — user has acted
    clearTimeout(this._minDisplayTimer);
    this._minDisplayTimer = null;
    this.hide(); // now hide() will execute because timer is cleared

    this._confirmation.textContent = message;
    this._updateConfirmationPosition();

    // Bug C fix: Show via inline styles
    Object.assign(this._confirmation.style, {
      opacity: '1',
      transform: 'translateY(0)',
    });

    // Hide after timeout
    setTimeout(() => {
      Object.assign(this._confirmation.style, {
        opacity: '0',
        transform: 'translateY(6px)',
      });
    }, message.includes('allowlist') ? 2000 : 1500);
  }

  /** Full cleanup — remove from DOM, cancel all timers. */
  destroy() {
    this._cancelLongPress();

    // Bug B fix: cleanup minimum display timer
    clearTimeout(this._minDisplayTimer);
    this._minDisplayTimer = null;

    window.removeEventListener('resize', this._boundHandlers.resize);
    document.removeEventListener('fullscreenchange', this._boundHandlers.fullscreenChange);

    if (this._badge) {
      this._badge.removeEventListener('pointerdown', this._boundHandlers.pointerDown);
      this._badge.removeEventListener('pointerup', this._boundHandlers.pointerUp);
      this._badge.removeEventListener('pointerleave', this._boundHandlers.pointerLeave);
      this._badge.removeEventListener('click', this._boundHandlers.click);
      this._badge.remove();
      this._badge = null;
    }

    if (this._confirmation) {
      this._confirmation.remove();
      this._confirmation = null;
    }

    this._isVisible = false;
  }

  // ─── DOM Creation ─────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = BADGE_STYLES;
    document.head.appendChild(style);
  }

  _createBadge() {
    this._badge = document.createElement('div');
    this._badge.className = 'skn-badge';

    // Build badge content using DOM API — no innerHTML (YouTube Trusted Types policy)
    // Icon wrapper
    const iconWrap = document.createElement('span');
    iconWrap.className = 'skn-badge-icon';
    iconWrap.appendChild(buildMutedIcon());

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'skn-badge-text';
    labelEl.textContent = 'Sakina muted this · Undo';

    // Progress ring SVG
    const ringsvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringsvg.setAttribute('class', 'skn-badge-ring');
    ringsvg.setAttribute('viewBox', '0 0 100 100');
    ringsvg.setAttribute('preserveAspectRatio', 'none');

    this._ringCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this._ringCircle.setAttribute('cx', '50');
    this._ringCircle.setAttribute('cy', '50');
    this._ringCircle.setAttribute('r', '48');
    this._ringCircle.setAttribute('stroke-dasharray', '301.6');
    this._ringCircle.setAttribute('stroke-dashoffset', '301.6');
    ringsvg.appendChild(this._ringCircle);

    this._badge.appendChild(iconWrap);
    this._badge.appendChild(labelEl);
    this._badge.appendChild(ringsvg);

    // Attach event listeners
    this._badge.addEventListener('pointerdown', this._boundHandlers.pointerDown);
    this._badge.addEventListener('pointerup', this._boundHandlers.pointerUp);
    this._badge.addEventListener('pointerleave', this._boundHandlers.pointerLeave);
    this._badge.addEventListener('click', this._boundHandlers.click);

    document.body.appendChild(this._badge);

    // Bug C fix: Set initial hidden state via inline styles (immune to CSS cascade)
    Object.assign(this._badge.style, {
      opacity: '0',
      transform: 'translateY(6px)',
      transition: 'opacity 200ms ease-out, transform 200ms ease-out',
      pointerEvents: 'none',
    });
  }

  _createConfirmation() {
    this._confirmation = document.createElement('div');
    this._confirmation.className = 'skn-confirmation';
    document.body.appendChild(this._confirmation);

    // Bug C fix: Set initial hidden state via inline styles
    Object.assign(this._confirmation.style, {
      opacity: '0',
      transform: 'translateY(6px)',
      transition: 'opacity 200ms ease-out, transform 200ms ease-out',
      pointerEvents: 'none',
    });
  }

  // ─── Positioning ──────────────────────────────────────────────────────────────

  // Bug A fix: validate container rect before using it
  _updatePosition() {
    if (!this._badge) return;

    const offset = window.innerWidth < 600 ? 8 : 16;
    const container = this._getPlayerContainer();

    let bottom = offset;
    let right = offset;

    if (container && container !== document.body) {
      const rect = container.getBoundingClientRect();
      const isValidRect = rect.width > 0 && rect.height > 0 &&
                          rect.bottom > 0 && rect.right > 0;

      if (isValidRect) {
        // Position badge inside the player, offset from bottom-right corner
        bottom = window.innerHeight - rect.bottom + offset;
        right = window.innerWidth - rect.right + offset;

        // Clamp: never place the badge outside the visible viewport
        bottom = Math.max(offset, Math.min(bottom, window.innerHeight - 60));
        right = Math.max(offset, Math.min(right, window.innerWidth - 60));
      } else {
        // Container rect is zero/degenerate (Shorts, lazy-rendered players)
        // Use safe viewport-relative fallback
        bottom = 72; // clears YouTube's bottom control bar
        right = offset;
      }
    }

    this._badge.style.bottom = `${bottom}px`;
    this._badge.style.right = `${right}px`;
    this._badge.style.top = 'auto';
    this._badge.style.left = 'auto';
  }

  // Bug A fix: same rect-validation pattern for confirmation
  _updateConfirmationPosition() {
    if (!this._confirmation) return;

    const offset = window.innerWidth < 600 ? 8 : 16;
    const container = this._getPlayerContainer();

    let bottom = offset;
    let right = offset;

    if (container && container !== document.body) {
      const rect = container.getBoundingClientRect();
      const isValidRect = rect.width > 0 && rect.height > 0 &&
                          rect.bottom > 0 && rect.right > 0;

      if (isValidRect) {
        bottom = window.innerHeight - rect.bottom + offset;
        right = window.innerWidth - rect.right + offset;
        bottom = Math.max(offset, Math.min(bottom, window.innerHeight - 60));
        right = Math.max(offset, Math.min(right, window.innerWidth - 60));
      } else {
        bottom = 72;
        right = offset;
      }
    }

    this._confirmation.style.bottom = `${bottom}px`;
    this._confirmation.style.right = `${right}px`;
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────────

  _onClick(e) {
    // Only fire if not a long press completion
    if (this._pressStartTime && Date.now() - this._pressStartTime < LONG_PRESS_DURATION) {
      e.preventDefault();
      e.stopPropagation();
      this._pressStartTime = null; // clear here, after use
      this._onSessionUnmute?.();
    }
  }

  _onPointerDown(e) {
    e.preventDefault();
    this._pressStartTime = Date.now();

    // Start long press animation
    this._longPressTimer = setTimeout(() => {
      // Long press completed
      this._onAllowlist?.();
      this._pressStartTime = null;
    }, LONG_PRESS_DURATION);

    // Start ring animation
    this._animateRing();
  }

  _onPointerUp() {
    // Cancel timer and ring animation only.
    // Do NOT clear _pressStartTime here — _onClick fires after pointerup
    // and needs it to distinguish a short click from a completed long press.
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._ringCircle) {
      this._ringCircle.style.strokeDashoffset = '301.6';
    }
  }

  _onPointerLeave() {
    this._cancelLongPress();
  }

  _cancelLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._pressStartTime = null;

    // Reset ring
    if (this._ringCircle) {
      this._ringCircle.style.strokeDashoffset = '301.6';
    }
  }

  _animateRing() {
    if (!this._ringCircle || !this._pressStartTime) return;

    const elapsed = Date.now() - this._pressStartTime;
    const progress = Math.min(elapsed / LONG_PRESS_DURATION, 1);

    // stroke-dasharray is 301.6 (circumference of r=48 circle)
    // offset goes from 301.6 (invisible) to 0 (full circle)
    const offset = 301.6 * (1 - progress);
    this._ringCircle.style.strokeDashoffset = String(offset);

    if (progress < 1 && this._pressStartTime) {
      this._rafId = requestAnimationFrame(() => this._animateRing());
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  _debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
}

/**
 * Extract a URL pattern for the current page (used for allowlist).
 * On YouTube, tries to get /@ChannelName. Otherwise uses hostname + first path segment.
 */
export function getPagePattern() {
  const hostname = location.hostname; // e.g. www.youtube.com

  // YouTube: try to extract /@ChannelName from canonical link or page metadata
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    try {
      const url = new URL(canonical.href);
      const parts = url.pathname.split('/').filter(Boolean);
      // /@ChannelName/videos → use /@ChannelName
      if (parts[0]?.startsWith('@')) return `${hostname}/${parts[0]}`;
    } catch {
      // Ignore parsing errors
    }
  }

  // Fallback: use current pathname up to second segment
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0]?.startsWith('@')) return `${hostname}/${parts[0]}`;

  // Last resort: hostname + first path segment
  return parts.length > 0 ? `${hostname}/${parts[0]}` : hostname;
}
