// 로컬 색인·통합 검색 검증. 빈 임시 DB 로 MCP 서버를 띄워 도구로 색인을 채우고,
// 같은 회의록 원문을 이 프로세스에서 직접 훑은 결과(정답)와 검색 결과를 대조한다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const WORK = mkdtempSync(join(tmpdir(), 'assembly-index-'));
const DB = join(WORK, 'index.db');
// search-index.js 는 불러올 때 경로를 정하므로 env 를 먼저 둔다
process.env.ASSEMBLY_INDEX_DB = DB;
const { closeBrowser, fetchText } = await import('../src/browser.js');
const { parseMinutesView } = await import('../src/minutes.js');
const { autoSave, closeIndex, normalize, saveDoc, searchIndex } = await import('../src/search-index.js');

const CONFER = '52773'; // 2025-03-13 국토교통위원회, 468차례
const CONF_ID = '054846'; // 같은 회의의 nanet id
const CAPTION_DATE = process.argv[2] ?? '2026-10-28';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

let client;
async function connect() {
  client = new Client({ name: 'index-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
      env: { ...process.env, ASSEMBLY_INDEX_DB: DB, ASSEMBLY_REPORT_DIR: join(WORK, 'reports') },
    }),
  );
}
async function call(name, args) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) {
    check(`${name} 호출`, false, text.slice(0, 300));
    return null;
  }
  console.log(`  · ${name} ${Date.now() - t}ms`);
  return JSON.parse(text);
}
const search = (args) => call('assembly_search', { remote: 'off', limit: 100, ...args });

await connect();
const tools = (await client.listTools()).tools.map((t) => t.name);
check('도구 17개(assembly_search·assembly_index 포함)', tools.length === 17 && tools.includes('assembly_search') && tools.includes('assembly_index'), String(tools.length));
const empty = await call('assembly_index', { action: 'status' });
check('빈 색인 상태', empty?.sources.length === 0 && empty.db === DB, empty?.db);

// 1. 회의록 도구를 쓰면 자동 저장, 다시 쓰면 그대로
const sp = await call('assembly_meeting_speeches', { confer_num: CONFER, max_chars_per_member: 500 });
check('회의록 조회 시 자동 색인', sp?.index === `added(${sp?.turn_count})` && sp.turn_count === 468, `${sp?.index}, ${sp?.title}, ${sp?.date}, ${sp?.committee}`);
const sp2 = await call('assembly_meeting_speeches', { confer_num: CONFER, members: ['맹성규'] });
check('같은 회의 재조회는 unchanged', sp2?.index === 'unchanged(468)', sp2?.index);
const st = await call('assembly_index', { action: 'status' });
const m0 = st?.sources.find((s) => s.source === 'minutes');
check('상태: 문서 1·조각 468·날짜', m0?.docs === 1 && m0.chunks === 468 && m0.first_date === '2025-03-13', JSON.stringify(m0));

// 정답: 같은 원문을 직접 받아 차례마다 정규화한 본문
const turns = parseMinutesView(await fetchText(`https://record.assembly.go.kr/assembly/viewer/minutes/xml.do?id=${CONFER}&type=view`, { timeoutMs: 60000 }));
const kept = turns.filter((t) => t.text.trim()); // 빈 차례는 저장하지 않는다
const norms = kept.map((t) => normalize(t.text).toLowerCase());
const truth = (terms) => norms.map((n, i) => (terms.every((t) => n.includes(t.toLowerCase())) ? i : -1)).filter((i) => i >= 0);
check('원문 차례 수 = 저장 조각 수', kept.length === m0?.chunks, `${kept.length} vs ${m0?.chunks}`);

// 2. 무작위 구절 재현율·정확도: 원문에서 뽑은 구절마다 검색 건수 = 직접 훑은 건수, 출처 차례가 결과에 있다
let seed = 20250313;
const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
const bad = [];
for (let k = 0; k < 40; k++) {
  const i = rand(norms.length);
  const len = k < 10 ? 2 : 3 + rand(6); // 10개는 2글자(LIKE 경로)
  if (norms[i].length < len) continue;
  const at = rand(norms[i].length - len + 1);
  const term = normalize(kept[i].text).slice(at, at + len);
  if (/["\s]/.test(term)) continue;
  const r = await searchIndex({ query: `"${term}"`, limit: 1000 });
  const want = truth([term]);
  if (r.total_hits !== want.length || !r.hits.some((h) => h.seq === i)) bad.push(`${term}: ${r.total_hits} vs ${want.length}`);
}
check('무작위 구절 40개: 건수 일치·출처 차례 포함', bad.length === 0, bad.join(' / ') || '전부 일치');

// 3. 대표 검색어(도구 경유)
const js = await search({ query: '전세사기' });
check('전세사기 = 원문 6차례', js?.local.total_hits === truth(['전세사기']).length && js.local.total_hits === 6, `${js?.local.total_hits}, 첫 결과 ${js?.local.hits[0]?.speaker}`);
check('결과마다 【】 강조·url', js?.local.hits.every((h) => h.snippet.includes('【') && h.url.includes(CONFER)), js?.local.hits[0]?.snippet);
check('로컬에 있으면 auto 는 원격 안 봄', js && !('remote' in js), '');
const spaced = await search({ query: '"전세 사기"' });
check('띄어쓰기 무시("전세 사기" = 전세사기)', spaced?.local.total_hits === 6, String(spaced?.local.total_hits));
const multi = await search({ query: '전세 사기 피해' });
check('낱말 AND(2글자 LIKE 경로)', multi?.local.total_hits === truth(['전세', '사기', '피해']).length && multi.local.query.scanned_terms.length === 3, `${multi?.local.total_hits} vs ${truth(['전세', '사기', '피해']).length}`);
const mixed = await search({ query: '전세사기 피해자' });
check('3글자 이상 색인 + 2글자 혼합', mixed?.local.total_hits === truth(['전세사기', '피해자']).length, `${mixed?.local.total_hits}`);

// 4. 거르기·쪽 나누기·정렬
const counts = await Promise.all(
  [
    { from: '2025-03-14' },
    { to: '2025-03-13' },
    { committee: '국토' },
    { committee: '법제' },
    { sources: ['caption'] },
    { speaker: '맹성규' },
  ].map(async (f) => (await search({ query: '전세사기', ...f }))?.local.total_hits),
);
const chairWant = kept.filter((t, i) => t.name === '맹성규' && norms[i].includes('전세사기')).length;
check('날짜·위원회·출처·발언자 거르기', JSON.stringify(counts) === JSON.stringify([0, 6, 6, 0, 0, chairWant]), `${JSON.stringify(counts)} (맹성규 정답 ${chairWant})`);
const p1 = await search({ query: '전세사기', limit: 4 });
const p2 = await search({ query: '전세사기', limit: 4, offset: p1?.local.next_offset });
const seqs = [...(p1?.local.hits ?? []), ...(p2?.local.hits ?? [])].map((h) => h.seq);
check('쪽 나누기(4+2, 중복 없음)', p1?.local.next_offset === 4 && p2?.local.returned === 2 && !p2.local.next_offset && new Set(seqs).size === 6, seqs.join(','));
const byDate = await search({ query: '전세사기', order: 'date' });
check('order=date', byDate?.local.total_hits === 6, '');

// 5. 기간 색인: 이미 있는 회의는 건너뛰고, force 면 다시 받아도 내용이 같으면 unchanged
const im = await call('assembly_index', { action: 'meetings', from: '2025-03-13', committee: '국토교통' });
const mine = im?.results.find((r) => String(r.confer_num) === CONFER);
check('기간 색인: 있는 회의 건너뜀', mine?.status === 'skipped(already)', JSON.stringify(im && { ...im, results: im.results.map((r) => `${r.confer_num} ${r.status}`) }));
const imf = await call('assembly_index', { action: 'meetings', from: '2025-03-13', committee: '국토교통', force: true });
const mineF = imf?.results.find((r) => String(r.confer_num) === CONFER);
check('기간 색인 force: 같은 내용이면 unchanged', mineF?.status === 'unchanged(468)' && imf.errors === 0, mineF?.status);

// 6. 검토보고서·국감 결과보고서 PDF 본문
const rep = await call('assembly_bill_reports', { bill_no: '2219960', max_chars: 1000 });
check('검토보고서 조회 시 자동 색인', /^added\(\d+\)$/.test(rep?.index ?? ''), `${rep?.index}, 본문 ${rep?.text?.total_chars}자`);
const repHit = await search({ query: '2219960 검토보고', sources: ['bill_report'] });
check('검토보고서 본문 검색', repHit?.local.total_hits > 0 && repHit.local.hits.every((h) => h.source === 'bill_report' && h.meta?.bill_no === '2219960' && Number.isInteger(h.offset)), `${repHit?.local.total_hits}건, ${repHit?.local.hits[0]?.title}`);
const aud = await call('assembly_audit_reports', { year: 2025, query: '행정안전' });
const docId = aud?.items[0]?.doc_id;
const found = docId && (await call('assembly_audit_reports', { doc_id: docId, find: '주호영위원' }));
check('국감 결과보고서 조회 시 자동 색인', /^added\(\d+\)$/.test(found?.index ?? ''), found?.index);
const audHit = await search({ query: '주호영위원', sources: ['audit_report'] });
// 조각 경계에 걸친 일치는 빠질 수 있어 조각 수 ≤ 본문 일치 수
check('국감 보고서 본문 검색', audHit?.local.total_hits > 0 && audHit.local.total_hits <= found?.find?.hits && audHit.local.hits.every((h) => h.snippet.replace(/\s/g, '').includes('주호영위원')), `조각 ${audHit?.local.total_hits} / 본문 일치 ${found?.find?.hits}`);
const st2 = await call('assembly_index', { action: 'status' });
const br = st2?.sources.find((s) => s.source === 'bill_report');
check('검토보고서 글자 수 ≈ 추출 본문(공백 조각만 빠짐)', br && br.chars <= rep.text.total_chars && br.chars > rep.text.total_chars * 0.98, `${br?.chars} vs ${rep?.text?.total_chars}`);

// 7. 자막 녹화
const ci = await call('assembly_index', { action: 'captions', date: CAPTION_DATE });
const c0 = ci?.results[0];
check(`${CAPTION_DATE} 자막 녹화 색인`, ci?.recordings > 0 && ci.results.every((r) => r.status === `added(${r.turns})` || r.status === `unchanged(${r.turns})`), JSON.stringify(ci?.results));
if (c0) {
  const cap = await call('assembly_live_captions', { date: CAPTION_DATE, xcode: c0.key.split('/')[1].split('_')[0], max_chars: 3000 });
  check('자막 조회는 같은 녹화를 다시 저장하지 않음', /^unchanged\(\d+\)$/.test(cap?.recordings[0]?.index ?? ''), cap?.recordings[0]?.index);
  const phrase = /[가-힣]{6,}/.exec(cap?.recordings[0]?.blocks.map((b) => b.transcript).join(' ') ?? '')?.[0];
  const capHit = phrase && (await search({ query: phrase, sources: ['caption'] }));
  check('자막 본문 검색', capHit?.local.total_hits > 0 && capHit.local.hits[0].key === c0.key, `"${phrase}" ${capHit?.local.total_hits}건`);
}

// 8. 다른 프로세스가 쓰는 동안 저장·갱신, 갱신 후 옛 내용이 FTS 에 남지 않음
const doc = (text) => ({ source: 'caption', key: 'test/synthetic', title: '합성', date: '2000-01-01', chunks: [{ text }] });
check('다른 프로세스에서 저장', saveDoc(doc('가나다라마바사 합성시험문장 하나')).status === 'added', '');
const viaServer = await search({ query: '합성시험문장' });
check('서버가 다른 프로세스의 저장을 봄', viaServer?.local.total_hits === 1, String(viaServer?.local.total_hits));
check('내용 바뀌면 updated', saveDoc(doc('바뀐내용입니다 둘째')).status === 'updated', '');
check('갱신 후 옛 낱말 0건·새 낱말 1건', searchIndex({ query: '합성시험문장' }).total_hits === 0 && searchIndex({ query: '바뀐내용' }).total_hits === 1, '');
process.env.ASSEMBLY_INDEX = 'off';
check('ASSEMBLY_INDEX=off 면 저장 안 함', autoSave(doc('끈상태')) === 'off', '');
delete process.env.ASSEMBLY_INDEX;

// 9. 원격(국회도서관): 같은 회의를 찾아 일치 발언을 연다
const rem = await call('assembly_search', { query: '전세사기', committee: '국토교통', remote: 'only', remote_detail: 3 });
const r0 = rem?.remote?.meetings.find((m) => m.conf_id === CONF_ID);
check('원격 only 는 로컬을 건너뜀', rem && !('local' in rem) && rem.remote.meetings.length > 0, '');
check(`원격: ${CONF_ID} 목록 6/468 = 상세 일치 6 = 로컬 6`, r0?.matched_speeches === 6 && r0.total_speeches === 468 && r0.matched_in_detail === 6, JSON.stringify(r0 && { ...r0, matches: r0.matches?.length }));
const detailed = rem?.remote?.meetings.filter((m) => 'matched_in_detail' in m) ?? [];
// 목록은 형태소 검색이라 상세(붙은 낱말 그대로)보다 많을 수 있다
check(
  '원격 상세: 일치 발언마다 검색어 포함, 목록 건수 이하',
  detailed.length === 3 && detailed.every((m) => m.matched_in_detail > 0 && m.matched_in_detail <= m.matched_speeches && m.matches.every((x) => normalize(x.snippet).includes('【전세사기】'))),
  detailed.map((m) => `${m.conf_id} ${m.matched_in_detail}/${m.matched_speeches}`).join(', '),
);
const rf = await call('assembly_search', { query: '전세사기', committee: '법제사법', remote: 'only', remote_detail: 0 });
check('원격 위원회 패싯', rf?.remote?.meetings.length > 0 && rf.remote.meetings.every((m) => m.title.includes('법제사법')), rf?.remote?.meetings.map((m) => m.title.slice(-14)).join(' / '));
const auto = await call('assembly_search', { query: '우주항공청 설립', remote_detail: 0 });
check('로컬 0건이면 auto 가 원격 검색', auto?.local.total_hits === 0 && auto.remote?.meetings.length > 0, `원격 ${auto?.remote?.meetings.length}건`);

// 10. 재시작 후에도 남아 있음, FTS 무결성
await client.close();
await connect();
const after = await search({ query: '전세사기', sources: ['minutes'] });
check('서버 재시작 후 검색 유지', after?.local.total_hits === 6, '');
await client.close();
closeIndex();
const raw = new DatabaseSync(DB);
const n = raw.prepare('SELECT (SELECT COUNT(*) FROM chunks) AS c, (SELECT COUNT(*) FROM chunks_fts) AS f').get();
let integrity = 'ok';
try {
  raw.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)");
} catch (e) {
  integrity = e.message;
}
check('FTS 행 수 = 조각 수, integrity-check 통과', n.c === n.f && integrity === 'ok', `${n.c} / ${n.f}, ${integrity}`);
raw.close();

await closeBrowser();
rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed}건 실패` : '\n전부 통과');
process.exit(failed ? 1 : 0);
