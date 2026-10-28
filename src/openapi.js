// 열린국회정보 OpenAPI (open.assembly.go.kr/portal/openapi/{서비스ID})
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchJson } from './browser.js';

const BASE = 'https://open.assembly.go.kr/portal/openapi';
const CRED = join(homedir(), '.config', 'assembly-data', 'credentials');

let cachedKey;
function apiKey() {
  if (cachedKey === undefined) {
    cachedKey = process.env.ASSEMBLY_API_KEY ?? '';
    if (!cachedKey) {
      try {
        // trim 은 Windows 편집기가 붙이는 BOM 과 CRLF 의 \r 도 지운다
        const line = readFileSync(CRED, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.startsWith('ASSEMBLY_API_KEY='));
        cachedKey = line ? line.slice('ASSEMBLY_API_KEY='.length).trim() : '';
      } catch {
        cachedKey = '';
      }
    }
  }
  return cachedKey;
}

/**
 * 한 페이지 호출. 응답 형식: {서비스ID:[{head:[{list_total_count},{RESULT}]},{row:[...]}]}
 * 결과 없음(INFO-200)은 빈 rows 로 돌려준다.
 */
export async function callOpenApi(service, params = {}, { pIndex = 1, pSize = 100 } = {}) {
  const qs = new URLSearchParams({ KEY: apiKey(), Type: 'json', pIndex: String(pIndex), pSize: String(pSize) });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const json = await fetchJson(`${BASE}/${service}?${qs}`);
  const body = json[service];
  if (!body) {
    // 오류 시에는 {RESULT:{CODE,MESSAGE}} 만 온다
    const r = json.RESULT ?? {};
    if (r.CODE === 'INFO-200') return { total: 0, rows: [] };
    throw new Error(`OpenAPI ${service}: ${r.CODE ?? '?'} ${r.MESSAGE ?? JSON.stringify(json).slice(0, 200)}`);
  }
  const head = body[0]?.head ?? [];
  const total = head.find((h) => 'list_total_count' in h)?.list_total_count ?? 0;
  const result = head.find((h) => h.RESULT)?.RESULT;
  if (result && result.CODE !== 'INFO-000') throw new Error(`OpenAPI ${service}: ${result.CODE} ${result.MESSAGE}`);
  return { total, rows: body[1]?.row ?? [] };
}

/** 전체 페이지를 모은다 (max 건까지). */
export async function callOpenApiAll(service, params = {}, { pSize = 300, max = 5000 } = {}) {
  const rows = [];
  let total = 0;
  for (let pIndex = 1; rows.length < max; pIndex++) {
    const page = await callOpenApi(service, params, { pIndex, pSize });
    total = page.total;
    rows.push(...page.rows);
    if (page.rows.length < pSize || rows.length >= total) break;
  }
  return { total, rows: rows.slice(0, max) };
}

/**
 * field 내림차순(최신순)으로 오는 목록에서 [from, to] 안의 행만 모은다. need 건이 차거나 from 보다 오래된 쪽에 닿으면 멈춘다.
 * 앞 5000건만 받아 거르면 오래된 기간이 조용히 0건이 되므로, to 가 시작되는 쪽을 쪽 번호 이분 탐색으로 찾는다.
 */
export async function callOpenApiDateRange(service, params, { field, from, to, need, pSize = 300 }) {
  const cache = new Map();
  const page = async (i) => {
    if (!cache.has(i)) cache.set(i, await callOpenApi(service, params, { pIndex: i, pSize }));
    return cache.get(i);
  };
  const { total } = await page(1);
  const pages = Math.ceil(total / pSize);
  const day = (r) => r?.[field] ?? '';
  // 마지막 행이 to 이하인 첫 쪽부터 읽는다
  let lo = 1;
  let hi = pages;
  while (to && lo < hi) {
    const mid = (lo + hi) >> 1;
    if (day((await page(mid)).rows.at(-1)) <= to) hi = mid;
    else lo = mid + 1;
  }
  const rows = [];
  for (let i = lo; i <= pages && rows.length < need; i++) {
    const p = await page(i);
    rows.push(...p.rows.filter((r) => (!from || day(r) >= from) && (!to || day(r) <= to)));
    if ((from && day(p.rows.at(-1)) < from) || p.rows.length < pSize) break;
  }
  return { total, rows };
}

/** 사이트의 API 명세(요청 변수·출력 필드) 조회. infSeq 는 카탈로그 openSrv 의 "A-n" 의 n. */
export async function openApiMeta(infId, infSeq) {
  const json = await fetchJson('https://open.assembly.go.kr/portal/data/openapi/selectOpenApiMeta.do', {
    form: { infId, infSeq: String(infSeq) },
  });
  return json.data;
}

/** 카탈로그 전체 (infaId, infaNm, openSrv ...) */
export async function openApiCatalog() {
  const json = await fetchJson(
    'https://open.assembly.go.kr/portal/openapi/selectInfsOpenApiListPaging.do?page=1&rows=400&schVOrder=D',
  );
  return json.data;
}
