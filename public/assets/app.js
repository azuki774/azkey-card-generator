(() => {
  const form = document.querySelector('form[action="/cards"]');
  const status = document.querySelector('#preview-status');
  const errorMessage = document.querySelector('#form-error');
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) return;

  const submitButton = form.querySelector('button[type="submit"]');
  const sides = ['front', 'back'];
  let objectUrls = [];

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

  const setBusy = (busy) => {
    form.toggleAttribute('aria-busy', busy);
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = busy;
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
    if (!form.reportValidity()) return;

    resetCards();
    if (errorMessage instanceof HTMLElement) {
      errorMessage.hidden = true;
      errorMessage.textContent = '';
    }
    status.textContent = '生成中';
    setBusy(true);

    try {
      const response = await fetch('/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'カード画像を生成できませんでした。');

      showCard('front', payload.cards?.front);
      showCard('back', payload.cards?.back);
      status.textContent = '生成済み';
    } catch (error) {
      resetCards();
      status.textContent = '生成失敗';
      if (errorMessage instanceof HTMLElement) {
        errorMessage.textContent = error instanceof Error ? error.message : 'カード画像を生成できませんでした。';
        errorMessage.hidden = false;
      }
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener('pagehide', resetCards);
})();
