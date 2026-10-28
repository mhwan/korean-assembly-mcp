// 국회 사이트들은 비브라우저 클라이언트(curl, urllib)에 400을 돌려주므로
// 시스템 Chrome을 헤드리스로 띄우고, 대상 출처의 페이지 안에서 fetch 해 응답을 받는다. UA는 바꾸지 않는다.
import { chromium } from 'playwright-core';

// 지정하지 않으면 playwright 의 chrome 채널이 OS별 기본 설치 위치(macOS·Windows·Linux)에서 찾는다
const CHROME = process.env.ASSEMBLY_CHROME;

let contextPromise = null;
const pages = new Map(); // origin -> Promise<Page>

async function context() {
  if (!contextPromise) {
    contextPromise = chromium
      .launch({ ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }), headless: true })
      .then((browser) => browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' }));
  }
  return contextPromise;
}

async function pageFor(origin) {
  if (!pages.has(origin)) {
    const p = (async () => {
      const page = await (await context()).newPage();
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return page;
    })();
    pages.set(origin, p);
    p.catch(() => pages.delete(origin));
  }
  return pages.get(origin);
}

/**
 * 대상 출처 페이지 안에서 fetch 한다.
 * form 이 있으면 application/x-www-form-urlencoded POST.
 */
export async function fetchText(url, opts) {
  return (await fetchRaw(url, opts, false)).text;
}

/** 바이너리(PDF 등). 응답 본문을 base64 로 넘겨 Buffer 로 돌려준다. */
export async function fetchBytes(url, opts) {
  const { text, contentType } = await fetchRaw(url, opts, true);
  return { bytes: Buffer.from(text, 'base64'), contentType };
}

async function fetchRaw(url, { method, form, timeoutMs = 30000 } = {}, binary) {
  const origin = new URL(url).origin;
  const page = await pageFor(origin);
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const args = { url, method: method ?? (body ? 'POST' : 'GET'), body, timeoutMs, binary };
  // 출처 첫 페이지가 스크립트로 다른 곳에 이동하면 실행 컨텍스트가 사라지므로, 이동이 끝나길 기다려 다시 시도한다
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await evaluateFetch(page, args);
      break;
    } catch (e) {
      if (attempt >= 2 || !/Execution context was destroyed|navigat/i.test(e.message)) throw e;
      await page.waitForLoadState('load').catch(() => {});
    }
  }
  if (result.status !== 200) {
    throw new Error(`HTTP ${result.status} ${new URL(url).pathname}: ${binary ? '' : result.text.slice(0, 200)}`);
  }
  return result;
}

function evaluateFetch(page, args) {
  return page.evaluate(
    async ({ url, method, body, timeoutMs, binary }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          body,
          headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : undefined,
          credentials: 'include',
          signal: ctrl.signal,
        });
        const contentType = res.headers.get('content-type') ?? '';
        if (!binary) return { status: res.status, text: await res.text(), contentType };
        const buf = new Uint8Array(await res.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { status: res.status, text: btoa(s), contentType };
      } catch (e) {
        return { status: 0, text: String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
    args,
  );
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

export async function closeBrowser() {
  if (!contextPromise) return;
  const ctx = await contextPromise;
  contextPromise = null;
  pages.clear();
  await ctx.browser()?.close();
}
