import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appJsPath = resolve(testDirectory, '../public/assets/app.js');

interface FakeResponse {
  ok: boolean;
  status: number;
  headersMap: Record<string, string>;
  payload?: unknown;
  jsonThrows?: boolean;
}

function successPayload() {
  const data = Buffer.from('front-png').toString('base64');
  return {
    cards: {
      front: { data, mediaType: 'image/png', fileName: 'front.png' },
      back: { data, mediaType: 'image/png', fileName: 'back.png' },
    },
  };
}

function makeResponse(spec: FakeResponse) {
  return {
    ok: spec.ok,
    status: spec.status,
    headers: {
      get: (name: string) => spec.headersMap[name.toLowerCase()] ?? null,
    },
    json: async () => {
      if (spec.jsonThrows) throw new Error('bad json');
      return spec.payload ?? {};
    },
  };
}

async function loadAppSource(): Promise<string> {
  return readFile(appJsPath, 'utf8');
}

interface Harness {
  submit: () => Promise<void>;
  firePagehide: () => void;
  advance: (ms: number) => void;
  elapseWithoutTimers: (ms: number) => void;
  state: {
    fetchCalls: number;
    button: any;
    status: any;
    errorBox: any;
    form: any;
    imageFront: any;
    nowMs: () => number;
  };
  setFetchImpl: (impl: (...args: any[]) => Promise<any>) => void;
  setValidity: (valid: boolean) => void;
  flush: () => Promise<void>;
}

function createHarness(appSource: string): Harness {
  let nowMs = 1_000_000;
  let timerId = 0;
  const pending: { id: number; at: number; cb: (...a: any[]) => void }[] = [];
  let fetchImpl: (...args: any[]) => Promise<any> = async () => makeResponse({ ok: true, status: 200, headersMap: {}, payload: successPayload() });
  let validity = true;
  let fetchCalls = 0;

  const sandbox: any = {};
  sandbox.globalThis = sandbox;

  class HTMLElement {
    hidden = false;
    textContent = '';
    private attrs = new Map<string, string>();
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    removeAttribute(name: string) { this.attrs.delete(name); }
    hasAttribute(name: string) { return this.attrs.has(name); }
  }
  class HTMLFormElement extends HTMLElement {
    listeners = new Map<string, ((e: any) => void)[]>();
    reportValidity() { return validity; }
    toggleAttribute(name: string, force?: boolean) {
      if (force === undefined) {
        if (this.hasAttribute(name)) { this.removeAttribute(name); return false; }
        this.setAttribute(name, ''); return true;
      }
      if (force) { this.setAttribute(name, ''); return true; }
      this.removeAttribute(name); return false;
    }
    addEventListener(type: string, cb: (e: any) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(cb);
      this.listeners.set(type, list);
    }
    querySelector(sel: string) {
      if (sel.includes('button')) return sandbox.__button;
      if (sel.includes('#username')) return sandbox.__username;
      return null;
    }
  }
  class HTMLButtonElement extends HTMLElement {
    disabled = false;
    querySelector(sel: string) {
      if (sel === 'span') return sandbox.__buttonLabel;
      return null;
    }
  }
  class HTMLInputElement extends HTMLElement {
    value = 'alice';
    selectionStart: number | null = null;
    selectionEnd: number | null = null;
    inputListeners = new Map<string, ((e: any) => void)[]>();
    addEventListener(type: string, cb: (e: any) => void) {
      const list = this.inputListeners.get(type) ?? [];
      list.push(cb);
      this.inputListeners.set(type, list);
    }
    setRangeText() { /* no-op for tests */ }
  }
  class HTMLImageElement extends HTMLElement {
    src = '';
    removeAttribute(name: string) {
      super.removeAttribute(name);
      if (name === 'src') this.src = '';
    }
  }
  class HTMLAnchorElement extends HTMLElement {
    href = '';
    download = '';
    classSet = new Set<string>();
    classList = {
      add: (c: string) => { this.classSet.add(c); },
      remove: (c: string) => { this.classSet.delete(c); },
    };
    removeAttribute(name: string) {
      super.removeAttribute(name);
      if (name === 'href') this.href = '';
      if (name === 'download') this.download = '';
    }
  }

  const form = new HTMLFormElement();
  const status = new HTMLElement();
  const errorBox = new HTMLElement();
  errorBox.hidden = true;
  const button = new HTMLButtonElement();
  const buttonLabel = new HTMLElement();
  buttonLabel.textContent = 'カードを作る';
  const username = new HTMLInputElement();
  const placeholderFront = new HTMLElement();
  const placeholderBack = new HTMLElement();
  const imageFront = new HTMLImageElement();
  const imageBack = new HTMLImageElement();
  const downloadFront = new HTMLAnchorElement();
  const downloadBack = new HTMLAnchorElement();
  imageFront.hidden = true;
  imageBack.hidden = true;

  sandbox.__button = button;
  sandbox.__buttonLabel = buttonLabel;
  sandbox.__username = username;
  sandbox.HTMLFormElement = HTMLFormElement;
  sandbox.HTMLElement = HTMLElement;
  sandbox.HTMLButtonElement = HTMLButtonElement;
  sandbox.HTMLInputElement = HTMLInputElement;
  sandbox.HTMLImageElement = HTMLImageElement;
  sandbox.HTMLAnchorElement = HTMLAnchorElement;

  sandbox.document = {
    querySelector: (sel: string) => {
      if (sel === 'form[action="/cards"]') return form;
      if (sel === '#preview-status') return status;
      if (sel === '#form-error') return errorBox;
      if (sel === '#username') return username;
      if (sel.includes('placeholder="front"')) return placeholderFront;
      if (sel.includes('placeholder="back"')) return placeholderBack;
      if (sel.includes('card-image="front"')) return imageFront;
      if (sel.includes('card-image="back"')) return imageBack;
      if (sel.includes('download-link="front"')) return downloadFront;
      if (sel.includes('download-link="back"')) return downloadBack;
      return null;
    },
  };

  const pagehideHandlers: ((e: any) => void)[] = [];
  sandbox.window = {
    addEventListener: (type: string, cb: (e: any) => void) => {
      if (type === 'pagehide') pagehideHandlers.push(cb);
    },
  };

  sandbox.setTimeout = (cb: (...a: any[]) => void, ms = 0) => {
    timerId += 1;
    pending.push({ id: timerId, at: nowMs + Math.max(0, ms), cb });
    return timerId;
  };
  sandbox.clearTimeout = (id: number) => {
    const index = pending.findIndex((t) => t.id === id);
    if (index >= 0) pending.splice(index, 1);
  };
  const RealDate = Date;
  sandbox.Date = { now: () => nowMs, parse: (s: string) => RealDate.parse(s) };
  sandbox.fetch = (...args: any[]) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
  sandbox.atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  sandbox.Blob = class Blob {
    constructor(public parts: unknown[], public opts?: unknown) {}
  };
  let blobCount = 0;
  sandbox.URL = {
    createObjectURL: () => `blob:fake-${(blobCount += 1)}`,
    revokeObjectURL: () => undefined,
  };
  sandbox.FormData = class FormData {
    constructor(public form?: unknown) {}
    entries() { return [][Symbol.iterator](); }
    [Symbol.iterator]() { return [][Symbol.iterator](); }
  };
  sandbox.URLSearchParams = URLSearchParams;

  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox, { filename: 'app.js' });

  const submitHandler = form.listeners.get('submit')?.[0];
  assert.ok(submitHandler, 'app.js must register a submit handler');

  const advance = (ms: number) => {
    const target = nowMs + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > target) break;
      pending.shift();
      nowMs = next.at;
      next.cb();
    }
    nowMs = target;
  };

  return {
    submit: () => submitHandler({ preventDefault: () => undefined }),
    firePagehide: () => { for (const h of pagehideHandlers) h({}); },
    advance,
    elapseWithoutTimers: (ms) => { nowMs += ms; },
    state: {
      get fetchCalls() { return fetchCalls; },
      button, status, errorBox, form, imageFront,
      nowMs: () => nowMs,
    },
    setFetchImpl: (impl) => { fetchImpl = impl; },
    setValidity: (v) => { validity = v; },
    flush: async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('frontend preserves form-encoded generation requests', async () => {
  const source = await loadAppSource();
  assert.match(source, /'Content-Type': 'application\/x-www-form-urlencoded'/);
  assert.match(source, /body: new URLSearchParams\(new FormData\(form\)\)/);
});

test('double submit while in-flight issues one request (button, Enter, programmatic)', async () => {
  const h = createHarness(await loadAppSource());
  const gate = deferred<any>();
  h.setFetchImpl(() => gate.promise);
  const first = h.submit();
  await h.flush();
  assert.equal(h.state.fetchCalls, 1);
  assert.equal(h.state.button.disabled, true);
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  // Second submit while busy (Enter/programmatic path) is ignored.
  await h.submit();
  await h.flush();
  assert.equal(h.state.fetchCalls, 1);
  gate.resolve(makeResponse({ ok: true, status: 200, headersMap: {}, payload: successPayload() }));
  await first;
  await h.flush();
  assert.equal(h.state.fetchCalls, 1);
  // Cooldown active: further submits still ignored.
  await h.submit();
  assert.equal(h.state.fetchCalls, 1);
});

test('validation failure before request never starts the cooldown', async () => {
  const h = createHarness(await loadAppSource());
  h.setValidity(false);
  await h.submit();
  await h.flush();
  assert.equal(h.state.fetchCalls, 0);
  assert.equal(h.state.button.disabled, false);
  h.setValidity(true);
  await h.submit();
  await h.flush();
  assert.equal(h.state.fetchCalls, 1);
});

test('success waits 3s with a stable generating label, preserves preview, then re-enables', async () => {
  const h = createHarness(await loadAppSource());
  await h.submit();
  await h.flush();
  assert.equal(h.state.status.textContent, '生成済み');
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  assert.equal(h.state.button.disabled, true);
  assert.equal(h.state.form.hasAttribute('aria-busy'), false);
  // Preview preserved during the wait.
  assert.equal(h.state.imageFront.hidden, false);
  h.advance(2_999);
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  assert.equal(h.state.button.disabled, true);
  await h.submit();
  assert.equal(h.state.fetchCalls, 1);
  h.advance(1);
  assert.equal(h.state.button.disabled, false);
  assert.equal(h.state.button.querySelector('span').textContent, 'カードを作る');
  assert.equal(h.state.status.textContent, '生成済み');
  // Expired: a new submit works.
  await h.submit();
  await h.flush();
  assert.equal(h.state.fetchCalls, 2);
});

test('failure also waits 3s and re-enables with a sane status', async () => {
  const h = createHarness(await loadAppSource());
  h.setFetchImpl(async () => makeResponse({ ok: false, status: 500, headersMap: {}, payload: { error: { message: 'boom' } } }));
  await h.submit();
  await h.flush();
  assert.equal(h.state.status.textContent, '生成失敗');
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  assert.equal(h.state.button.disabled, true);
  assert.equal(h.state.errorBox.hidden, false);
  h.advance(3_000);
  assert.equal(h.state.button.disabled, false);
  assert.equal(h.state.status.textContent, '生成失敗');
});

test('429 Retry-After extends the cooldown (seconds and HTTP-date)', async () => {
  const h = createHarness(await loadAppSource());
  h.setFetchImpl(async () => makeResponse({ ok: false, status: 429, headersMap: { 'retry-after': '30' }, payload: { error: { message: 'slow' } } }));
  await h.submit();
  await h.flush();
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  assert.equal(h.state.status.textContent, '生成失敗');
  h.advance(11_000);
  assert.equal(h.state.button.disabled, true);
  h.advance(19_000);
  assert.equal(h.state.button.disabled, false);

  const h2 = createHarness(await loadAppSource());
  const httpDate = new Date(h2.state.nowMs() + 20_000).toUTCString();
  h2.setFetchImpl(async () => makeResponse({ ok: false, status: 429, headersMap: { 'retry-after': httpDate }, payload: { error: { message: 'slow' } } }));
  await h2.submit();
  await h2.flush();
  assert.equal(h2.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  assert.equal(h2.state.button.disabled, true);
  h2.advance(19_999);
  assert.equal(h2.state.button.disabled, true);
  h2.advance(1);
  assert.equal(h2.state.button.disabled, false);
});

test('network failure and bad JSON leave a sane 3s wait and re-enable', async () => {
  const h = createHarness(await loadAppSource());
  h.setFetchImpl(async () => { throw new Error('network down'); });
  await h.submit();
  await h.flush();
  assert.equal(h.state.status.textContent, '生成失敗');
  assert.equal(h.state.button.disabled, true);
  h.advance(3_000);
  assert.equal(h.state.button.disabled, false);

  const h2 = createHarness(await loadAppSource());
  h2.setFetchImpl(async () => makeResponse({ ok: true, status: 200, headersMap: {}, jsonThrows: true }));
  await h2.submit();
  await h2.flush();
  assert.equal(h2.state.status.textContent, '生成失敗');
  h2.advance(3_000);
  assert.equal(h2.state.button.disabled, false);
});

test('429 with a non-JSON body still honors Retry-After', async () => {
  const h = createHarness(await loadAppSource());
  h.setFetchImpl(async () => makeResponse({ ok: false, status: 429, headersMap: { 'retry-after': '30' }, jsonThrows: true }));
  await h.submit();
  assert.equal(h.state.button.querySelector('span').textContent, 'しばらくお待ちください');
  h.advance(10_000);
  assert.equal(h.state.button.disabled, true);
  h.advance(20_000);
  assert.equal(h.state.button.disabled, false);
});

test('a delayed expiry timer cannot overwrite the next generating status', async () => {
  const h = createHarness(await loadAppSource());
  await h.submit();
  h.elapseWithoutTimers(4_000);
  const gate = deferred<any>();
  h.setFetchImpl(() => gate.promise);
  const next = h.submit();
  h.advance(1_000);
  assert.equal(h.state.status.textContent, 'しばらくお待ちください');
  assert.equal(h.state.button.disabled, true);
  gate.resolve(makeResponse({ ok: true, status: 200, headersMap: {}, payload: successPayload() }));
  await next;
});

test('aria-busy only during generating; pagehide never ends an in-flight wait', async () => {
  const h = createHarness(await loadAppSource());
  const gate = deferred<any>();
  h.setFetchImpl(() => gate.promise);
  const first = h.submit();
  await h.flush();
  assert.equal(h.state.form.hasAttribute('aria-busy'), true);
  h.firePagehide();
  // Still generating: button stays disabled, fetch not duplicated.
  assert.equal(h.state.button.disabled, true);
  await h.submit();
  assert.equal(h.state.fetchCalls, 1);
  gate.resolve(makeResponse({ ok: true, status: 200, headersMap: {}, payload: successPayload() }));
  await first;
  await h.flush();
  assert.equal(h.state.form.hasAttribute('aria-busy'), false);
  assert.equal(h.state.button.disabled, true);
  h.advance(3_000);
  assert.equal(h.state.button.disabled, false);
});
