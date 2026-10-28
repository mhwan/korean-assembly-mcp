// 의안 첨부 문서(검토보고서·심사보고서·의안원문·체계자구검토보고서)와 국회 소속기관 발간물
// 문서 목록: likms billInfo.do 의 FileGate 링크(type=0 HWP, type=1 PDF). 본문: PDF → pdftotext.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchBytes, fetchText } from './browser.js';
import { callOpenApi, callOpenApiAll } from './openapi.js';
import { autoSave, chunkText } from './search-index.js';

const LIKMS = 'https://likms.assembly.go.kr';
const REPORT_DIR = process.env.ASSEMBLY_REPORT_DIR ?? join(homedir(), '.cache', 'assembly-mcp', 'reports');
// GUI 로 뜬 MCP 클라이언트는 셸 PATH 를 못 받을 수 있어 Homebrew 위치를 먼저 보고, 없으면 PATH 에서 찾는다
const PDFTOTEXT =
  process.env.ASSEMBLY_PDFTOTEXT ??
  ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'].find((p) => existsSync(p)) ??
  'pdftotext';

// 대안(위원회안)에는 검토·심사보고서 대신 위원회의결안·위원회제출안이 붙는다
export const DOC_KINDS = ['검토보고서', '심사보고서', '의안원문', '체계자구검토보고서', '위원회의결안', '위원회제출안'];

const unescapeHtml = (s) =>
  s?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** billInfo.do 응답에서 첨부 문서 목록. 제목 예: "소관위 심사정보 검토보고서", "(법사위 체계자구) 심사정보 체계자구검토보고서" */
async function billDocs(bill) {
  // billId·billNo 만 보내면 의안원문 행이 빠지므로 화면이 보내는 구분값을 함께 보낸다
  const html = await fetchText(`${LIKMS}/bill/bi/bill/detail/billInfo.do`, {
    form: {
      billId: bill.BILL_ID, billNo: bill.BILL_NO, billKindCd: 'BKC_0004',
      reexamYn: 'N', mainUpdateBillYn: 'N', tmprAnYn: 'N', stageMemo: 'N',
    },
  });
  const flat = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
  const docs = [];
  for (const m of flat.matchAll(/FileGate\?bookId=([\w-]+)&amp;type=1[^>]*?title="([^"(]+?)\s*\(PDF/g)) {
    const bookId = m[1];
    const title = unescapeHtml(m[2]);
    if (docs.some((d) => d.book_id === bookId)) continue;
    docs.push({
      kind: title.trim().split(' ').at(-1),
      title: title.trim(),
      book_id: bookId,
      pdf_url: `${LIKMS}/filegate/servlet/FileGate?bookId=${bookId}&type=1`,
      hwp_url: `${LIKMS}/filegate/servlet/FileGate?bookId=${bookId}&type=0`,
    });
  }
  return docs;
}

/** PDF 를 받아 텍스트로. bookId 별로 캐시하고, entry(색인 정보)가 있으면 본문을 색인에도 넣는다. */
async function docText(doc, entry) {
  const text = await pdfText(doc);
  if (entry) {
    doc.index = autoSave({ ...entry, key: doc.book_id, title: doc.title, url: doc.pdf_url, chunks: chunkText(text) });
  }
  return text;
}

async function pdfText(doc) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const txt = join(REPORT_DIR, `${doc.book_id}.txt`);
  if (existsSync(txt)) return readFileSync(txt, 'utf8');
  const { bytes } = await fetchBytes(doc.pdf_url, { timeoutMs: 90000 });
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`PDF 가 아닌 응답입니다: ${doc.title}`);
  const pdf = join(REPORT_DIR, `${doc.book_id}.pdf`);
  writeFileSync(pdf, bytes);
  let raw;
  try {
    raw = execFileSync(PDFTOTEXT, ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`pdftotext 를 찾지 못했습니다(${PDFTOTEXT}). poppler 를 설치하거나 ASSEMBLY_PDFTOTEXT 로 경로를 지정하세요.`);
    throw e;
  }
  const text = raw
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, '  ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  writeFileSync(txt, text);
  return text;
}

/** 대안(위원회안)의 원안들: 같은 법률명으로 제안되어 대안반영폐기된 의안 */
async function originalBills(bill, age) {
  const lawName = bill.BILL_NM.replace(/\s*\(대안\)\s*$/, '').replace(/\s*(일부|전부)개정법률안$|\s*제정법률안$|\s*법률안$/, '');
  const { rows } = await callOpenApiAll('ALLBILLV2', { ERACO: `제${age}대`, BILL_NM: lawName }, { pSize: 300, max: 1000 });
  return rows
    .filter((r) => /대안반영/.test(r.JRCMIT_PROC_RSLT ?? '') && (r.JRCMIT_PROC_DT ?? '') === (bill.JRCMIT_PROC_DT ?? r.JRCMIT_PROC_DT))
    .map((r) => ({ bill_id: r.BILL_ID, bill_no: r.BILL_NO, name: r.BILL_NM, proposer: r.PPSR_NM, proposed: r.PPSL_DT, committee_result: r.JRCMIT_PROC_RSLT }));
}

/**
 * 의안 첨부 문서 목록과 (doc 지정 시) 그 본문.
 * 대안은 검토보고서·심사보고서가 원안들에 붙어 있으므로 원안 목록을 함께 준다.
 */
export async function billReports({ bill_id, bill_no, doc = '검토보고서', offset = 0, max_chars = 30000, age = 22 }) {
  const bill = (await callOpenApi('ALLBILLV2', { ERACO: `제${age}대`, BILL_ID: bill_id, BILL_NO: bill_no })).rows[0];
  if (!bill) throw new Error(`의안을 찾지 못했습니다: ${bill_id ?? bill_no}`);
  const docs = await billDocs(bill);
  const out = {
    bill: { bill_id: bill.BILL_ID, bill_no: bill.BILL_NO, name: bill.BILL_NM, committee: bill.JRCMIT_NM, committee_result: bill.JRCMIT_PROC_RSLT },
    documents: docs.map(({ kind, title, pdf_url, hwp_url }) => ({ kind, title, pdf_url, hwp_url })),
  };
  const isAlt = /\(대안\)\s*$/.test(bill.BILL_NM);
  if (isAlt) out.original_bills = await originalBills(bill, age).catch(() => []);
  if (doc === 'none') return out;

  const target = docs.find((d) => d.kind === doc);
  if (!target) {
    out.note = isAlt && (doc === '검토보고서' || doc === '심사보고서')
      ? `대안에는 ${doc}가 붙지 않습니다. original_bills 의 의안번호로 다시 조회하세요.`
      : `${doc}가 아직 없습니다(심사 전이거나 미등록).`;
    return out;
  }
  const text = await docText(target, {
    source: 'bill_report',
    date: bill.PPSL_DT ?? null,
    committee: bill.JRCMIT_NM ?? null,
    meta: { bill_id: bill.BILL_ID, bill_no: bill.BILL_NO, bill_name: bill.BILL_NM, kind: target.kind },
  });
  const start = Math.max(0, offset);
  const end = Math.min(text.length, start + max_chars);
  out.index = target.index;
  out.text = { kind: target.kind, title: target.title, total_chars: text.length, offset: start, body: text.slice(start, end) };
  if (end < text.length) out.text.next_offset = end;
  return out;
}

// ---------------------------------------------------------------------------
// 국정감사 결과보고서(AUDITREPORTRESULT, 위원회·연도별 PDF)와 시정 및 처리요구사항에 대한 정부 처리결과보고서
// (VCONFATTATBLIST, 회의록 부록 PDF). AUDITREPORTRESULT 는 RPT_YR 만 걸러지고 CMIT_NM 은 무시되므로 위원회는 여기서 거른다.
// VCONFATTATBLIST 는 2001~2015년도 국감분(제15~20대)까지만 있다.

export const AUDIT_KINDS = ['result', 'correction'];
const AUDIT_SERVICES = { result: 'AUDITREPORTRESULT', correction: 'VCONFATTATBLIST' };
const CORRECTION_COVERAGE =
  '처리결과보고서 목록(VCONFATTATBLIST)은 2001~2015년도 국감분(제15~20대 회의록 부록)까지만 제공됩니다. ' +
  '최근 국감의 시정·처리요구사항은 kind=result 결과보고서의 section=corrections 로 읽고, 정부 처리결과는 이 API로 받을 수 없습니다.';

const auditCache = new Map(); // kind -> {at, rows}
const AUDIT_TTL_MS = 6 * 60 * 60 * 1000;

async function auditRows(kind) {
  const hit = auditCache.get(kind);
  if (hit && Date.now() - hit.at < AUDIT_TTL_MS) return hit.rows;
  const { rows } = await callOpenApiAll(AUDIT_SERVICES[kind], {}, { pSize: 1000, max: 5000 });
  const items = rows.map((r) =>
    kind === 'result'
      ? {
          doc_id: `r-${r.PDF_DWLD_URL.match(/(\d+)[^/]*$/)[1]}`, // 2000년분은 000270071.hwp.pdf 꼴
          year: Number(r.RPT_YR),
          committee: r.CMIT_NM,
          title: r.RPT_TTL.replace(/\(\)$/, ''),
          pdf_url: r.PDF_DWLD_URL,
          hwp_url: r.HWP_DWLD_URL,
        }
      : {
          doc_id: `c-${r.DOWN_URL.match(/fileId=(\d+)/)[1]}`,
          year: Number(r.FILE_CN.match(/(\d{4})년도/)?.[1]) || null, // 감사 연도. 제목에 없으면 null
          title: r.FILE_CN.replace(/^\s*(\d+\.|o)\s*/, ''),
          agency: r.FILE_CN.match(/\(([^()]+)\)\s*$/)?.[1] ?? null,
          meeting: `${r.ERACO} ${r.SESS} ${r.DGR}`,
          conf_id: r.CONF_ID,
          pdf_url: r.DOWN_URL,
        },
  );
  auditCache.set(kind, { at: Date.now(), rows: items });
  return items;
}

// 띄어쓰기를 무시하고 찾는다(PDF 추출 텍스트는 "박정    현"처럼 글자 사이가 벌어진다)
const looseRegex = (q, flags = '') =>
  new RegExp([...q.replace(/\s+/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), flags);

/**
 * 국감 결과보고서·시정조치 처리결과보고서 목록, doc_id 지정 시 본문.
 * 본문은 section=corrections 로 결과보고서의 "시정 및 처리요구사항" 절부터, find 로 검색어 위치를 찾는다.
 */
export async function auditReports({ kind = 'result', year, query, doc_id, section = 'all', find, offset, max_chars = 30000, limit = 50 }) {
  if (doc_id) kind = doc_id.startsWith('c-') ? 'correction' : 'result';
  const rows = await auditRows(kind);
  const out = { kind, ...(kind === 'correction' ? { coverage: CORRECTION_COVERAGE } : {}) };

  if (!doc_id) {
    const q = query ? looseRegex(query) : null;
    const items = rows.filter(
      (r) => (!year || r.year === year) && (!q || q.test(r.committee ?? '') || q.test(r.title) || q.test(r.agency ?? '')),
    );
    return { ...out, matched: items.length, returned: Math.min(limit, items.length), items: items.slice(0, limit) };
  }

  const doc = rows.find((r) => r.doc_id === doc_id);
  if (!doc) throw new Error(`문서를 찾지 못했습니다: ${doc_id}`);
  const pdf = { book_id: doc_id.replace(/^r-/, 'audit-').replace(/^c-/, 'apdix-'), pdf_url: doc.pdf_url, title: doc.title };
  const text = await docText(pdf, {
    source: 'audit_report',
    date: null, // 결과보고서는 작성일이 없어 감사 연도만 meta 에 둔다
    committee: doc.committee ?? null,
    meta: { doc_id, kind, year: doc.year, ...(doc.agency ? { agency: doc.agency } : {}) },
  });
  out.document = doc;
  out.index = pdf.index;
  out.note = 'PDF 에서 뽑은 텍스트라 글자 사이 띄어쓰기가 벌어지거나 줄이 뒤섞일 수 있습니다. 인용·이름은 pdf_url 원문으로 확인하세요.';

  if (find) {
    const all = [...text.matchAll(looseRegex(find, 'g'))];
    const results = all.slice(0, 30).map((m) => ({
      offset: m.index,
      snippet: text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200),
    }));
    out.find = { query: find, hits: all.length, returned: results.length, results };
    if (offset === undefined) return out;
  }

  let start = Math.max(0, offset ?? 0);
  if (section === 'corrections' && offset === undefined) {
    // 절 제목 예: "VI. 시정 및 처리요구사항", "8. 시정 및 처리 요구사항", "7. 감사결과 시정 및 처리요구사항",
    // "Ⅶ. 국정감사 시정 및 처리요구사항(안) : 총 47건". 목차 줄은 같은 줄이나 바로 뒤 줄에 점선(··)이 붙어 거른다.
    const heading = /^[ \t]*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\d+)?\.?[ \t]*(?:[가-힣]+[ \t]+){0,2}시정[ \t]*및[ \t]*처리[ \t]*요구[ \t]*사항[^\n·]{0,20}$/gm;
    const at = [...text.matchAll(heading)].find((m) => !/·{2,}/.test(text.slice(m.index, m.index + m[0].length + 300)))?.index;
    if (at === undefined)
      out.section_note = '"시정 및 처리요구사항" 절 제목을 찾지 못해 처음부터 줍니다(2000년대 초 보고서는 기관별 【시정요구사항】 블록). find 로 찾아보세요.';
    else start = at;
  }
  const end = Math.min(text.length, start + max_chars);
  out.text = { total_chars: text.length, offset: start, body: text.slice(start, end) };
  if (end < text.length) out.text.next_offset = end;
  return out;
}

// ---------------------------------------------------------------------------
// 발간물: 5개 통합 API. 요청 변수 MTR_TTL(제목)·MTR_DIV(구분) 모두 부분일치. 응답은 날짜순이 아니다.

export const PUBLICATION_SOURCES = {
  법제실: 'ALLNASPBLM', // "국회발간물 통합 API" 이지만 실제 내용은 국회사무처 법제실(nas.na.go.kr) 자료
  입법조사처: 'ALLNARSPBLM',
  예산정책처: 'ALLNABOPBLM',
  미래연구원: 'ALLNAFIPBLM',
  국회도서관: 'ALLNANETPBLM',
};

const pubCache = new Map(); // `${service}|${title}|${div}` -> {at, rows}
const PUB_TTL_MS = 6 * 60 * 60 * 1000;

async function publicationRows(service, title, div) {
  const key = `${service}|${title ?? ''}|${div ?? ''}`;
  const hit = pubCache.get(key);
  if (hit && Date.now() - hit.at < PUB_TTL_MS) return hit.rows;
  const { rows } = await callOpenApiAll(service, { MTR_TTL: title, MTR_DIV: div }, { pSize: 1000, max: 10000 });
  pubCache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function searchPublications({ query, source = 'all', div, from, to, limit = 30 }) {
  const names = source === 'all' ? Object.keys(PUBLICATION_SOURCES) : [source];
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const rows = await publicationRows(PUBLICATION_SOURCES[name], query, div);
        return { name, rows };
      } catch (e) {
        return { name, rows: [], error: e.message };
      }
    }),
  );
  const items = results
    .flatMap(({ name, rows }) =>
      rows.map((r) => ({
        source: name,
        date: r.WRT_DT ?? null,
        kind: unescapeHtml(r.MTR_DIV) ?? null,
        title: unescapeHtml(r.MTR_TTL),
        ...(r.WRT_DEPT ? { dept: r.WRT_DEPT } : {}),
        ...(r.AUT_NM ? { author: r.AUT_NM } : {}),
        link: r.LINK_URL ?? null,
      })),
    )
    .filter((x) => (!from || (x.date ?? '') >= from) && (!to || (x.date ?? '') <= to))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return {
    matched: items.length,
    by_source: Object.fromEntries(results.map(({ name, rows, error }) => [name, error ? `오류: ${error}` : rows.length])),
    returned: Math.min(limit, items.length),
    items: items.slice(0, limit),
  };
}
