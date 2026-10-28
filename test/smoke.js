// MCP 서버를 stdio 로 띄워 도구를 실제로 부르고, 원천(회의록 요약 페이지·OpenAPI 원본)과 대조한다
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser, fetchText } from '../src/browser.js';

const MEETING_DATE = process.argv[2] ?? '2026-10-14';
const COMMITTEE = process.argv[3] ?? '행정안전';
const CLIP_DATE = process.argv[4] ?? '2026-10-27';

// 보고서 캐시를 빈 임시 폴더로 돌려 PDF 다운로드·추출 경로를 매번 실제로 거치게 한다. 색인도 같은 폴더에 둔다
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'assembly-reports-'));

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    env: { ...process.env, ASSEMBLY_REPORT_DIR: REPORT_DIR, ASSEMBLY_INDEX_DB: join(REPORT_DIR, 'index.db') },
  }),
);

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
async function call(name, args) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) {
    check(`${name} 호출`, false, text.slice(0, 300));
    return null;
  }
  console.log(`  · ${name} ${Date.now() - t}ms, ${text.length}자`);
  return JSON.parse(text);
}

const tools = (await client.listTools()).tools.map((t) => t.name);
check('도구 17개 등록', tools.length === 17, tools.join(', '));
const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
check('요약 prompt 등록', ['summarize_committee_speeches', 'summarize_meeting', 'summarize_live_captions'].every((p) => prompts.includes(p)), prompts.join(', '));
const mp = await client.getPrompt({ name: 'summarize_meeting', arguments: { confer_num: '57557', date: MEETING_DATE, committee: COMMITTEE } });
const mpText = mp.messages[0]?.content?.text ?? '';
check('회의 요약 prompt 인자 반영', mpText.includes('57557') && mpText.includes(`from: ${MEETING_DATE}`) && mpText.includes('핵심 논의사항'), `${mpText.length}자`);

// 1. 회의 찾기 → 발언 정리 → 회의록 요약 페이지와 대조
const meetings = await call('assembly_committee_meetings', { from: MEETING_DATE, committee: COMMITTEE });
check(`${MEETING_DATE} ${COMMITTEE} 회의 존재`, meetings?.length > 0, meetings?.map((m) => `${m.confer_num} ${m.title}`).join(' / '));
for (const m of meetings ?? []) {
  const sp = await call('assembly_meeting_speeches', { confer_num: String(m.confer_num), max_chars_per_member: 500 });
  if (!sp) continue;
  const viewHtml = await fetchText(sp.source_url, { timeoutMs: 60000 });
  const blocks = (viewHtml.match(/<div id="spk_\d+" class="[^"]*speaker/g) ?? []).length;
  check(`[${m.confer_num}] 발언 블록 수 = 원문 div.speaker 수`, sp.turn_count === blocks, `${sp.turn_count} vs ${blocks}`);

  const summary = await fetchText(sp.source_url.replace('type=view', 'type=summary'));
  const listed = new Set([...summary.matchAll(/data-name="([^"]+)"/g)].map((x) => x[1]));
  const nonMembers = new Set(sp.non_members.map((n) => n.speaker.split(' ')[0]));
  const expected = [...listed].filter((n) => !nonMembers.has(n)).sort();
  const got = sp.members.map((x) => x.name).sort();
  check(`[${m.confer_num}] 의원 목록 = 요약 페이지 발언자(비의원 제외)`, JSON.stringify(expected) === JSON.stringify(got), `${got.length}명 vs ${expected.length}명`);
  const noParty = sp.members.filter((x) => !x.party).map((x) => x.name);
  check(`[${m.confer_num}] 모든 의원에 정당`, noParty.length === 0, noParty.join(','));
  check(`[${m.confer_num}] 회의명`, Boolean(sp.title), sp.title);

  const one = sp.members.find((x) => x.position !== '위원장');
  if (one) {
    const f = await call('assembly_meeting_speeches', { confer_num: String(m.confer_num), members: [one.name] });
    const replies = (f?.members[0]?.transcript.match(/^ {2}↳ /gm) ?? []).length;
    check(`[${m.confer_num}] ${one.name} 필터·답변 포함`, f?.members.length === 1 && replies > 0, `차례 ${f?.members[0]?.turn_count}, 답변 ${replies}`);
  }
  break; // 한 건만 대조
}

// 1-1. 국감 회의록: 위원회 회의록 목록엔 없어 VCONFAPIGCONFLIST 로 섞어 넣는다
const audM = await call('assembly_committee_meetings', { from: '2026-10-06', committee: '법제사법' });
const audOne = audM?.find((m) => m.class === '국정감사 회의록');
check('국감 회의록 목록', Boolean(audOne) && audM.some((m) => m.class !== '국정감사 회의록'), audM?.map((m) => `${m.confer_num} ${m.class}`).join(' / '));
const audSp = audOne && (await call('assembly_meeting_speeches', { confer_num: audOne.confer_num, max_chars_per_member: 500 }));
check('국감 회의록 전문·머리글', audSp?.members.length > 5 && audSp.committee === '법제사법위원회' && /국정감사/.test(audSp.title), `${audSp?.title}, 의원 ${audSp?.members.length}`);

// 2. 발언영상(당일 보조)
const clips = await call('assembly_speech_clips', { date: CLIP_DATE });
const clipMembers = clips?.meetings.reduce((n, c) => n + c.members.length, 0);
check(`${CLIP_DATE} 발언영상 회의·의원`, clips?.meetings.length > 0 && clipMembers > 0, `회의 ${clips?.meetings.length}, 의원 ${clipMembers}`);
check('발언영상 날짜만이면 구간 생략', clips?.meetings.every((c) => c.members.every((g) => !g.items)) && !clips.meetings.some((c) => /\s$/.test(c.meeting)), `${JSON.stringify(clips).length}자`);
const clipOne = clips?.meetings[0]?.members[0]?.name;
if (clipOne) {
  const c1 = await call('assembly_speech_clips', { date: CLIP_DATE, member: clipOne });
  check(`발언영상 member(${clipOne}) 구간·링크`, c1?.meetings.every((c) => c.members.length === 1 && c.members[0].items?.length === c.members[0].clips && c.members[0].items.every((i) => i.video)), '');
}

// 2-1. 틀린 인자 이름은 오류(strict)
const bad = await client.callTool({ name: 'assembly_bills', arguments: { query: '전세사기' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
check('모르는 인자 거부', bad.isError === true, bad.content?.[0]?.text?.slice(0, 120));
// 잘못된 값은 조용히 빈 결과가 아니라 오류로 돌려준다
const rejects = async (label, name, args, re) => {
  const r = await client.callTool({ name, arguments: args }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  const text = r.content?.[0]?.text ?? '';
  check(label, r.isError === true && re.test(text), text.slice(0, 120));
};
await rejects('회의 기간 62일 초과 거부', 'assembly_committee_meetings', { from: '2026-01-01', to: '2026-04-01' }, /최대 62일/);
await rejects('회의 종료일 < 시작일 거부', 'assembly_committee_meetings', { from: '2026-10-10', to: '2026-10-01' }, /앞입니다/);
await rejects('없는 날짜 거부', 'assembly_committee_meetings', { from: '2026-02-30' }, /없는 날짜/);
await rejects('일정 날짜 형식 거부', 'assembly_schedule', { date: '내일' }, /YYYY/);
await rejects('자막 시각 범위 거부', 'assembly_live_captions', { from: '25:00' }, /HH:MM/);
await rejects('회의번호 숫자만', 'assembly_meeting_speeches', { confer_num: '../x' }, /숫자/);
await rejects('회의번호 정수만', 'assembly_meeting_speeches', { confer_num: 1.5 }, /양의 정수/);
await rejects('법안 종료일 < 시작일 거부', 'assembly_bills', { from: '2026-10-10', to: '2026-10-01' }, /앞입니다/);
await rejects('자막 종료 시각 < 시작 시각 거부', 'assembly_live_captions', { from: '15:00', to: '09:00' }, /앞입니다/);
await rejects('발언영상 없는 날짜 거부', 'assembly_speech_clips', { date: '2026-02-30' }, /없는 날짜/);
await rejects('openapi 서비스명 비움 거부', 'assembly_openapi', { service: '' }, /1문자/);
// 연 단위 일정은 5000건을 넘는다. 앞 달을 조용히 빼지 않고 좁히라고 알린다
await rejects('연 단위 일정은 좁히라고 알림', 'assembly_schedule', { date: '2026' }, /YYYY-MM/);
// 발언영상 원천은 같은 행을 두 번 주는 날이 있다(2026-10-23 김은혜: 원천 5행, 영상 4건)
const dup = await call('assembly_speech_clips', { date: '2026-10-23', member: '김은혜' });
const dupItems = dup?.meetings.flatMap((m) => m.members.flatMap((g) => g.items)) ?? [];
check('발언영상 중복 행 제거', dupItems.length === 4 && new Set(dupItems.map((i) => i.video)).size === 4, `구간 ${dupItems.length}`);

// 3. 의원
const members = await call('assembly_members', {});
check('의원 290~300명', members?.length >= 290 && members?.length <= 300, String(members?.length));
check('의원 정당 채움', members?.every((x) => x.party), '');

// 4. 법안 → 상세 → 표결
const bills = await call('assembly_bills', { limit: 5 });
check('발의법률안 최신순', bills?.bills.length === 5 && bills.bills[0].PROPOSE_DT >= bills.bills[4].PROPOSE_DT, bills?.bills.map((b) => `${b.PROPOSE_DT} ${b.BILL_NAME}`).join(' / '));
if (bills?.bills[0]) {
  const d = await call('assembly_bill_detail', { bill_no: bills.bills[0].BILL_NO });
  check('의안 상세(단계·제안이유·제안자)', d?.bill?.BILL_ID === bills.bills[0].BILL_ID && Boolean(d.summary) && d.proposers.length > 0, `제안자 ${d?.proposers.length}, 제안이유 ${d?.summary?.length ?? 0}자`);
}
// 3-1. 위원장안(대안): proposer 가 "…위원장"이면 자동으로 찾고, 대안 ↔ 원안이 서로 이어진다
// 두 API 모두 제안일 최신순 5000건 너머는 받지 않았었다. 오래된 기간도 쪽을 찾아가 채운다
const old = await call('assembly_bills', { from: '2024-06-01', to: '2024-06-30', limit: 50 });
check('오래된 기간 법안', old?.bills.length === 50 && old.bills.every((b) => b.PROPOSE_DT >= '2024-06-01' && b.PROPOSE_DT <= '2024-06-30'), `${old?.returned}건, ${old?.bills[0]?.PROPOSE_DT} ~ ${old?.bills.at(-1)?.PROPOSE_DT}`);
const chair = await call('assembly_bills', { proposer: '국토교통위원장', limit: 3 });
check('위원장안 검색', chair?.bills.length > 0 && chair.bills.every((b) => b.PROPOSER?.includes('국토교통위원장')), `${chair?.total}건, ${chair?.bills.map((b) => b.BILL_NAME).join(' / ')}`);
const altD = await call('assembly_bill_detail', { bill_no: '2221667' });
check('대안 상세 → 원안 목록', altD?.original_bills?.some((b) => b.bill_no === '2219960'), `원안 ${altD?.original_bills?.length}건`);
const origD = await call('assembly_bill_detail', { bill_no: '2219960' });
check('원안 상세 → 반영된 대안', origD?.alternative?.bill_no === '2221667', JSON.stringify(origD?.alternative));
// 법사위 위원장안은 위원회 처리일(CMT_PROC_DT)이 비어 제안일로 찾는다. 이름이 다른 대안도 원안 목록으로 확인한다
for (const [orig, alt] of [['2221200', '2221413'], ['2219873', '2220309']]) {
  const od = await call('assembly_bill_detail', { bill_no: orig });
  check(`법사 원안 ${orig} → 대안 ${alt}`, od?.alternative?.bill_no === alt, JSON.stringify(od?.alternative)?.slice(0, 150));
}
check('의안 상세 제안자 압축', origD?.proposers.every((p) => Object.keys(p).every((k) => ['name', 'party', 'rep', 'role'].includes(k))) && origD.proposers[0]?.rep === '대표발의', `${origD?.proposer_count}명, 첫 ${JSON.stringify(origD?.proposers[0])}`);

const passed = await call('assembly_bills', { result: '원안가결', limit: 1 });
if (passed?.bills[0]) {
  const v = await call('assembly_votes', { bill_id: passed.bills[0].BILL_ID });
  const sum = Object.values(v?.by_result ?? {}).reduce((a, b) => a + b, 0);
  check('표결 집계 = 의원별 합', v?.tally && Number(v.tally.VOTE_TCNT) === (v.by_result['찬성'] ?? 0) + (v.by_result['반대'] ?? 0) + (v.by_result['기권'] ?? 0), `총투표 ${v?.tally?.VOTE_TCNT}, 의원행 ${sum}, ${JSON.stringify(v?.by_result)}`);
}

// 4-1. 검토보고서: 원안(대안반영폐기)은 본문, 대안은 원안 목록
const rep = await call('assembly_bill_reports', { bill_no: '2219960', max_chars: 2000 });
const flatBody = rep?.text?.body.replace(/\s/g, '') ?? '';
check(
  '검토보고서 PDF 본문',
  rep?.documents.some((d) => d.kind === '검토보고서') && flatBody.includes('검토보고') && flatBody.includes('2219960') && rep.text.total_chars > 10000,
  `문서 ${rep?.documents.map((d) => d.kind).join(',')}, 본문 ${rep?.text?.total_chars}자`,
);
const rep2 = rep?.text?.next_offset && (await call('assembly_bill_reports', { bill_no: '2219960', offset: rep.text.next_offset, max_chars: 1000 }));
check('검토보고서 이어 읽기', rep2?.text?.offset === 2000 && rep2.text.body.length === 1000, `offset ${rep2?.text?.offset}`);
const alt = await call('assembly_bill_reports', { bill_no: '2221667', doc: 'none' });
check('대안 → 원안 목록', alt?.original_bills?.some((b) => b.bill_no === '2219960'), `원안 ${alt?.original_bills?.length}건`);

// 4-2. 발간물: 기관별 건수 = OpenAPI 원본 total, 최신순, 제목에 검색어
const pubs = await call('assembly_publications', { query: '인공지능', limit: 300 });
const narsRaw = await call('assembly_openapi', { service: 'ALLNARSPBLM', params: { MTR_TTL: '인공지능' }, size: 1 });
check('발간물 입법조사처 건수 = 원본', pubs?.by_source['입법조사처'] === narsRaw?.total, `${pubs?.by_source['입법조사처']} vs ${narsRaw?.total}`);
check(
  '발간물 최신순·검색어 포함',
  pubs?.items.length > 0 && pubs.items.every((x, i) => x.title.includes('인공지능') && (i === 0 || pubs.items[i - 1].date >= x.date)),
  `${pubs?.matched}건, ${JSON.stringify(pubs?.by_source)}`,
);

// 4-3. 국감 결과보고서·처리결과보고서: 건수 = OpenAPI 원본 total, 위원회 거르기, 시정요구 절, 띄어쓰기 무시 검색
const aud = await call('assembly_audit_reports', { year: 2024, limit: 400 });
const audRaw = await call('assembly_openapi', { service: 'AUDITREPORTRESULT', params: { RPT_YR: '2024' }, size: 1 });
check('결과보고서 2024 건수 = 원본', aud?.matched === audRaw?.total && aud.items.every((x) => x.year === 2024), `${aud?.matched} vs ${audRaw?.total}`);
const audAll = await call('assembly_audit_reports', { limit: 400 });
check('결과보고서 doc_id 중복 없음', audAll?.matched > 300 && new Set(audAll.items.map((x) => x.doc_id)).size === audAll.matched, `${audAll?.matched}건`);
const hang = await call('assembly_audit_reports', { year: 2025, query: '행정안전' });
const hangDoc = hang?.items[0];
check('결과보고서 위원회 거르기', hang?.matched === 1 && hangDoc.committee === '행정안전위원회', JSON.stringify(hangDoc));
const corr = hangDoc && (await call('assembly_audit_reports', { doc_id: hangDoc.doc_id, section: 'corrections', max_chars: 3000 }));
check(
  '결과보고서 시정·처리요구 절',
  !corr?.section_note && /^\S*\.?\s*시정\s*및\s*처리\s*요구\s*사항/.test(corr?.text?.body.trim() ?? '') && corr.text.offset > 100000 && corr.text.body.includes('행정안전부'),
  `offset ${corr?.text?.offset}/${corr?.text?.total_chars}, ${JSON.stringify(corr?.text?.body.slice(0, 40))}`,
);
const found = hangDoc && (await call('assembly_audit_reports', { doc_id: hangDoc.doc_id, find: '주호영위원' }));
check(
  '결과보고서 본문 검색',
  found?.find?.hits >= found?.find?.returned && found.find.returned > 0 && found.find.results.every((h) => h.snippet.replace(/\s/g, '').includes('주호영위원')) && !found.text,
  `${found?.find?.hits}건 중 ${found?.find?.returned}건`,
);
const fix = await call('assembly_audit_reports', { kind: 'correction', limit: 400 });
const fixRaw = await call('assembly_openapi', { service: 'VCONFATTATBLIST', params: {}, size: 1 });
check(
  '처리결과보고서 건수 = 원본·범위 안내',
  fix?.matched === fixRaw?.total && Math.max(...fix.items.map((x) => x.year ?? 0)) <= 2015 && /2015/.test(fix.coverage),
  `${fix?.matched} vs ${fixRaw?.total}, 최신 ${Math.max(...(fix?.items ?? []).map((x) => x.year ?? 0))}년도`,
);
const sea = fix?.items.find((x) => x.year === 2015 && x.agency === '해양수산부');
const seaText = sea && (await call('assembly_audit_reports', { doc_id: sea.doc_id, max_chars: 2000 }));
check('처리결과보고서 PDF 본문', seaText?.kind === 'correction' && seaText.text.total_chars > 50000 && seaText.text.body.replace(/\s/g, '').includes('처리결과보고서'), `${sea?.doc_id} ${seaText?.text?.total_chars}자`);

// 5. 일정·생중계
const sch = await call('assembly_schedule', { date: CLIP_DATE });
check(`${CLIP_DATE} 일정`, sch?.length > 0, `${sch?.length}건`);
const live = await call('assembly_live', {});
check('생중계 목록', live?.length > 0 && live.every((x) => x.name && x.xcode), `${live?.length}건`);
const onAir = await call('assembly_live', { only_live: true });
check('중계 중만 거르기', onAir?.every((x) => x.live) && onAir.length === live?.filter((x) => x.live).length, `${onAir?.length}/${live?.length}건`);
const idx = await call('assembly_index', {});
check('색인 인자 없이 = 상태', idx && typeof idx === 'object' && !Array.isArray(idx), Object.keys(idx ?? {}).join(','));

// 6. 자막 녹화 상태 → 오늘 녹화본이 있으면 블록으로 읽기
const rec = await call('assembly_live_captions_record', {});
check('자막 녹화 상태', Array.isArray(rec?.running) && Array.isArray(rec?.today), `실행 중 ${rec?.running.length}, 오늘 녹화 ${rec?.today.length}`);
const recorded = rec?.today.find((t) => t.lines > 0);
if (recorded) {
  const cap = await call('assembly_live_captions', { xcode: recorded.xcode, max_chars: 5000 });
  const r0 = cap?.recordings[0];
  check(`[${recorded.name}] 자막 블록`, r0?.turn_count > 0 && r0.blocks.length > 0 && r0.blocks.every((b) => /^\[\d{2}:\d{2}:\d{2}\]/.test(b.transcript)), `차례 ${r0?.turn_count}, 블록 ${r0?.blocks.length}, 의원 ${r0?.blocks.filter((b) => b.member).map((b) => b.member).join(',')}`);
}

// 7. 범용
const raw = await call('assembly_openapi', { service: 'ALLSCHEDULE', params: { SCH_DT: CLIP_DATE }, size: 5 });
check('범용 OpenAPI', raw?.total > 0, `total ${raw?.total}`);
const rawBig = await call('assembly_openapi', { service: 'nzmimeepazxkubdpn', params: { AGE: 22 }, size: 1000 });
check('범용 OpenAPI 큰 응답 줄임', rawBig && JSON.stringify(rawBig).length < 110000 && rawBig.rows.length < 1000 && /size/.test(rawBig.note ?? ''), `${rawBig?.rows.length}행, ${rawBig?.note}`);

await client.close();
await closeBrowser();
rmSync(REPORT_DIR, { recursive: true, force: true });
console.log(failed ? `\n${failed}건 실패` : '\n전부 통과');
process.exit(failed ? 1 : 0);
