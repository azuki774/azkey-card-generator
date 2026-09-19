(() => {
  const form = document.querySelector('form[action="/cards"]');
  const status = document.querySelector('#preview-status');
  const errorMessage = document.querySelector('#form-error');
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) return;

  const submitButton = form.querySelector('button[type="submit"]');
  const usernameInput = form.querySelector('#username');
  const sides = ['front', 'back'];
  let objectUrls = [];

  // Repeated-click guard (UI-only): one in-flight request plus a short
  // cooldown after each completed request. Direct API clients, reloads, and
  // multiple tabs bypass this; the server only bounds global concurrency
  // and upstream 429 backoff.
  const COOLDOWN_MS = 3_000;
  const MAX_COOLDOWN_MS = 300_000;
  let generating = false;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  const buttonLabel = submitButton instanceof HTMLButtonElement ? submitButton.querySelector('span') : null;
  const buttonOriginalText = buttonLabel instanceof HTMLElement ? buttonLabel.textContent : null;

  const normalizeUsernameInput = (value) => {
    const trimmed = value.trim();
    return trimmed.startsWith('@') && !trimmed.startsWith('@@') ? trimmed.slice(1) : trimmed;
  };

  if (usernameInput instanceof HTMLInputElement) {
    const normalizeInput = () => {
      usernameInput.value = normalizeUsernameInput(usernameInput.value);
    };
    usernameInput.addEventListener('blur', normalizeInput);
    usernameInput.addEventListener('paste', (event) => {
      event.preventDefault();
      const pastedText = event.clipboardData?.getData('text') ?? '';
      const start = usernameInput.selectionStart ?? usernameInput.value.length;
      const end = usernameInput.selectionEnd ?? start;
      usernameInput.setRangeText(pastedText, start, end, 'end');
      normalizeInput();
    });
  }

  const revokeObjectUrls = () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  };

  const resetCards = () => {
    revokeObjectUrls();
    for (const side of sides) {
      const placeholder = document.querySelector(`[data-card-placeholder="${side}"]`);
      const image = document.querySelector(`[data-card-image="${side}"]`);
      const download = document.querySelector(`[data-download-link="${side}"]`);
      if (placeholder instanceof HTMLElement) placeholder.hidden = false;
      if (image instanceof HTMLImageElement) {
        image.hidden = true;
        image.removeAttribute('src');
      }
      if (download instanceof HTMLAnchorElement) {
        download.removeAttribute('href');
        download.removeAttribute('download');
        download.setAttribute('aria-disabled', 'true');
        download.classList.remove('download-button--enabled');
      }
    }
  };

  const isCooling = () => Date.now() < cooldownUntil;

  const updateButton = () => {
    const disabled = generating || isCooling();
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = disabled;
    if (buttonLabel instanceof HTMLElement && buttonOriginalText !== null) {
      buttonLabel.textContent = disabled ? 'しばらくお待ちください' : buttonOriginalText;
    }
  };

  const setGenerating = (busy) => {
    generating = busy;
    if (busy) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
    updateButton();
  };

  const renderCooldown = () => {
    const remainingMs = cooldownUntil - Date.now();
    if (remainingMs <= 0) {
      if (cooldownTimer !== null) {
        clearTimeout(cooldownTimer);
        cooldownTimer = null;
      }
      cooldownUntil = 0;
      updateButton();
      return;
    }
    updateButton();
    if (cooldownTimer !== null) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(renderCooldown, remainingMs);
  };

  const startCooldown = (delayMs) => {
    const sane = Number.isFinite(delayMs) ? Math.floor(delayMs) : COOLDOWN_MS;
    const bounded = Math.min(Math.max(sane, COOLDOWN_MS), MAX_COOLDOWN_MS);
    cooldownUntil = Date.now() + bounded;
    renderCooldown();
  };

  const parseRetryAfterMs = (header) => {
    if (header == null) return undefined;
    const trimmed = String(header).trim();
    if (!trimmed || trimmed.length > 200) return undefined;
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
      return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff <= 0) return undefined;
      return Math.min(diff, MAX_COOLDOWN_MS);
    }
    return undefined;
  };

  const cooldownDelayFromResponse = (response) => {
    try {
      const header = response.headers?.get?.('Retry-After') ?? response.headers?.get?.('retry-after');
      const parsed = parseRetryAfterMs(header);
      if (parsed !== undefined) return Math.max(COOLDOWN_MS, parsed);
    } catch {
      // Fall through to the default cooldown below.
    }
    return COOLDOWN_MS;
  };

  const base64ToBlobUrl = (data, mediaType) => {
    const decoded = atob(data);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    objectUrls.push(url);
    return url;
  };

  const showCard = (side, card) => {
    if (!card || card.mediaType !== 'image/png' || typeof card.data !== 'string' || typeof card.fileName !== 'string') {
      throw new Error('画像レスポンスの形式が正しくありません。');
    }
    const placeholder = document.querySelector(`[data-card-placeholder="${side}"]`);
    const image = document.querySelector(`[data-card-image="${side}"]`);
    const download = document.querySelector(`[data-download-link="${side}"]`);
    if (!(image instanceof HTMLImageElement) || !(download instanceof HTMLAnchorElement)) {
      throw new Error('プレビューを表示できません。');
    }

    const url = base64ToBlobUrl(card.data, card.mediaType);
    if (placeholder instanceof HTMLElement) placeholder.hidden = true;
    image.src = url;
    image.hidden = false;
    download.href = url;
    download.download = card.fileName;
    download.setAttribute('aria-disabled', 'false');
    download.classList.add('download-button--enabled');
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // Guard every submit path (button, Enter key, programmatic submit):
    // a disabled button alone does not stop those.
    if (generating || isCooling()) return;
    if (usernameInput instanceof HTMLInputElement) usernameInput.value = normalizeUsernameInput(usernameInput.value);
    // A validation failure happens before any request, so it never starts
    // the post-request cooldown.
    if (!form.reportValidity()) return;

    // A background tab may delay the expiry timer beyond the deadline.
    // Clear that old timer before it can overwrite the next request's status.
    renderCooldown();
    resetCards();
    if (errorMessage instanceof HTMLElement) {
      errorMessage.hidden = true;
      errorMessage.textContent = '';
    }
    status.textContent = 'しばらくお待ちください';
    setGenerating(true);

    let cooldownDelayMs = COOLDOWN_MS;
    try {
      const response = await fetch('/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      // Preserve server backoff even when the response body is not JSON.
      if (response.status === 429) cooldownDelayMs = cooldownDelayFromResponse(response);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error('カード画像を生成できませんでした。');
      }
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? 'カード画像を生成できませんでした。');
      }

      showCard('front', payload.cards?.front);
      showCard('back', payload.cards?.back);
      status.textContent = '生成済み';
    } catch (error) {
      // A network failure has no response; keep the sane default cooldown.
      resetCards();
      status.textContent = '生成失敗';
      if (errorMessage instanceof HTMLElement) {
        errorMessage.textContent = error instanceof Error ? error.message : 'カード画像を生成できませんでした。';
        errorMessage.hidden = false;
      }
    } finally {
      // End the generating state first (clears aria-busy), then start the
      // post-request cooldown which keeps the same disabled button label
      // while leaving preview/results/downloads intact.
      setGenerating(false);
      startCooldown(cooldownDelayMs);
    }
  });

  // Page lifecycle: clearing previews on hide is fine, but never cancel the
  // in-flight/cooldown guard here. The submit handler owns that state, so a
  // hide during a request cannot re-enable the button early.
  window.addEventListener('pagehide', () => {
    if (!generating) resetCards();
  });
})();
