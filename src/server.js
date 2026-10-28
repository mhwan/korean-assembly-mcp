#!/usr/bin/env node
// 개인용 국회 데이터 MCP 서버 (stdio)
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeBrowser } from './browser.js';
import { indexCaptions, liveCaptions, startRecorder } from './captions.js';
import { billDetail, billVotes, liveList, schedule, searchBills } from './domains.js';
import { searchMembers } from './members.js';
import { committeeMeetings, indexMeetings, isRealDay, meetingSpeeches, speechClips } from './minutes.js';
import { callOpenApi } from './openapi.js';
import { auditReports, AUDIT_KINDS, billReports, DOC_KINDS, PUBLICATION_SOURCES, searchPublications } from './reports.js';
import { assemblySearch } from './search.js';
import { indexStats, INDEX_SOURCES, listDocs } from './search-index.js';

const SPECS = JSON.parse(readFileSync(new URL('../data/openapi-specs.json', import.meta.url), 'utf8'));
const SERVICE_LIST = SPECS.map(
  (s) => `- ${s.service} ${s.name}: ${s.request.map((r) => `${r.id}${r.need === 'Y' ? '*' : ''}`).join(', ')}`,
).join('\n');

z.config(z.locales.ko()); // 인자 검증 오류를 한국어로

const server = new McpServer({ name: 'assembly', version: '0.1.0' });

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
// strict: 틀린 인자 이름(예: query 대신 name)을 조용히 버리지 않고 오류로 돌려준다
// from·to 가 함께 있는 도구(날짜든 HH:MM 이든)는 거꾸로 준 범위를 빈 결과 대신 오류로 돌려준다
const ordered = (a, ctx) => {
  if (a.from && a.to && a.from > a.to) ctx.addIssue({ code: 'custom', path: ['to'], message: `종료가 시작보다 앞입니다: ${a.from} ~ ${a.to}` });
};
function tool(name, description, shape, run) {
  server.registerTool(name, { description, inputSchema: z.object(shape).strict().superRefine(ordered) }, async (args) => {
    try {
      return json(await run(args));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
    }
  });
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'YYYY-MM-DD', abort: true }).refine(isRealDay, '달력에 없는 날짜입니다');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM(00:00~23:59)');
// 회의 목록은 confer_num 을 숫자로 주므로 숫자와 숫자 문자열을 함께 받는다
const conferMsg = '회의번호는 양의 정수(숫자 또는 숫자 문자열)입니다';
const conferNum = z.union([z.string().regex(/^\d+$/, conferMsg), z.number().int(conferMsg).positive(conferMsg)], { error: conferMsg });

tool(
  'assembly_committee_meetings',
  '위원회 회의록 목록(열린국회정보 위원회 회의록 + 국정감사 회의록). 날짜 범위의 회의를 회의번호(confer_num)별로 안건과 함께 돌려준다. ' +
    '국감 회의록은 class 가 "국정감사 회의록"이고 안건이 비어 있다. ' +
    '회의록은 회의 후 약 1주 뒤 공개되므로(국감은 목록만 먼저 뜨고 전문은 늦게 열린다) 최근 회의는 assembly_speech_clips 를 쓴다.',
  {
    from: date.describe('시작일'),
    to: date.optional().describe('종료일(없으면 시작일 하루). 기간이 62일을 넘거나 시작일보다 앞이면 오류'),
    committee: z.string().optional().describe('위원회명 일부, 예: 행정안전, 법제사법'),
  },
  (a) => committeeMeetings(a),
);

tool(
  'assembly_meeting_speeches',
  '회의록 전문(record.assembly.go.kr)을 의원별로 묶어 발언 원문을 돌려준다. 의원마다 정당·지역구와 transcript(차례별 "[안건N] 발언" 단락, 답변은 "↳ 답변자: …")가 붙는다. ' +
    '분량이 크면 의원별 max_chars_per_member 로 잘린다(truncated=true). 특정 의원을 members 로 고르면 장관·증인 답변(replies)도 함께 준다.',
  {
    confer_num: conferNum.describe('assembly_committee_meetings 의 confer_num'),
    members: z.array(z.string()).optional().describe('의원 이름 목록(없으면 전원)'),
    max_chars_per_member: z.number().int().min(500).max(50000).optional().describe('의원별 원문 상한, 기본 3000(members 지정 시 20000)'),
    with_replies: z.boolean().optional().describe('의원 발언 직후 비의원 답변 포함(members 지정 시 기본 true)'),
    include_chair: z.boolean().optional().describe('위원장 진행 발언 포함, 기본 true'),
  },
  (a) =>
    meetingSpeeches(String(a.confer_num), {
      members: a.members,
      maxCharsPerMember: a.max_chars_per_member,
      withReplies: a.with_replies,
      includeChair: a.include_chair,
    }),
);

tool(
  'assembly_speech_clips',
  '국회의원 발언영상 목록(회의 당일 저녁~다음 날 공개). 회의별로 누가 몇 번, 몇 분 질의했는지 준다. 발언 원문은 없다. ' +
    'member 를 주면 그 의원의 영상 구간(답변자·길이·영상 링크)까지 준다. 국감 회의 제목엔 위원회명이 없고 피감기관만 있다.',
  {
    date: date.describe('회의일'),
    title: z.string().optional().describe('회의 제목 일부, 예: 국정감사, 행정안전위원회'),
    member: z.string().optional().describe('의원 이름'),
  },
  (a) => speechClips(a),
);

tool(
  'assembly_members',
  '제22대 국회의원 인적사항 검색(정당·지역구·소속위원회·당선횟수·연락처). 조건 없이 부르면 전원.',
  {
    name: z.string().optional(),
    party: z.string().optional(),
    committee: z.string().optional().describe('소속위원회명 일부'),
    district: z.string().optional().describe('선거구 일부, 예: 서울, 비례'),
  },
  (a) => searchMembers(a),
);

tool(
  'assembly_bills',
  '제22대 법률안 검색. 제안일 최신순. 기본은 의원 발의안만 찾는다. 위원장안(대안)·정부안은 proposer_kind 로 찾는다(proposer 가 "…위원장"이면 자동). ' +
    'total 은 기간(from·to)을 빼고 센 전체 건수다.',
  {
    name: z.string().optional().describe('법률안명 검색어'),
    proposer: z.string().optional().describe('제안자 검색어, 예: 홍길동의원, 국토교통위원장'),
    proposer_kind: z.enum(['의원', '위원장', '정부']).optional().describe('제안자 구분. 주면 의원·위원장·정부안 전체 목록(TVBPMBILL11)에서 찾는다'),
    committee: z.string().optional().describe('소관위원회 검색어'),
    result: z.string().optional().describe('본회의 심의결과, 예: 원안가결, 대안반영폐기'),
    from: date.optional().describe('제안일 시작'),
    to: date.optional().describe('제안일 끝'),
    limit: z.number().int().min(1).max(300).optional().describe('기본 30'),
  },
  (a) => searchBills(a),
);

tool(
  'assembly_bill_detail',
  '의안 상세: 단계별 일자·결과, 제안이유 및 주요내용, 제안자 목록(대표발의 먼저), 위원회 심사 회의. ' +
    '위원장안(대안)이면 반영된 원안 목록(original_bills), 대안반영폐기된 의안이면 그 대안(alternative)을 붙인다. 표결은 대안의 bill_id 로 assembly_votes 를 부른다. ' +
    '대안은 같은 위원회 위원장안 중 처리일이 같은 것에서 찾으므로 못 찾으면 alternative 가 안내 문장이다(그때는 assembly_bills proposer_kind=위원장 으로 찾는다).',
  { bill_id: z.string().optional().describe('의안ID(PRC_…)'), bill_no: z.string().optional().describe('의안번호') },
  (a) => {
    if (!a.bill_id && !a.bill_no) throw new Error('bill_id 또는 bill_no 가 필요합니다');
    return billDetail(a);
  },
);

tool(
  'assembly_bill_reports',
  '의안 첨부 문서 목록(의안원문·검토보고서·심사보고서·체계자구검토보고서 등, PDF/HWP 링크)과 doc 으로 고른 문서의 본문 텍스트(PDF 추출). ' +
    '검토보고서는 위원회 전문위원이 쓴 쟁점·찬반 분석이다. 본문이 길면 next_offset 으로 이어 읽는다. ' +
    '대안(위원회안)은 검토·심사보고서가 원안들에 붙으므로 original_bills 의 의안번호로 다시 부른다.',
  {
    bill_id: z.string().optional().describe('의안ID(PRC_…)'),
    bill_no: z.string().optional().describe('의안번호'),
    doc: z.enum([...DOC_KINDS, 'none']).optional().describe('본문을 받을 문서, 기본 검토보고서. none 이면 목록만'),
    offset: z.number().int().min(0).optional().describe('본문 시작 위치(이전 응답의 next_offset)'),
    max_chars: z.number().int().min(1000).max(200000).optional().describe('본문 상한, 기본 30000'),
  },
  (a) => {
    if (!a.bill_id && !a.bill_no) throw new Error('bill_id 또는 bill_no 가 필요합니다');
    return billReports(a);
  },
);

tool(
  'assembly_audit_reports',
  '국정감사 문서. kind=result 는 위원회별 국정감사 결과보고서(2000~, 감사 개요·기관별 질의 요지·시정 및 처리요구사항·증인 목록), ' +
    'kind=correction 은 시정 및 처리요구사항에 대한 정부 처리결과보고서(2001~2015년도 국감분만 있음). ' +
    'doc_id 없이 부르면 목록(최신순), doc_id 를 주면 PDF 본문 텍스트. section=corrections 는 결과보고서의 시정·처리요구 절부터 준다. ' +
    'find 는 띄어쓰기를 무시하고 본문에서 찾아 offset 과 앞뒤 문맥을 준다(의원 이름 찾기 등). 본문이 길면 next_offset 으로 이어 읽는다.',
  {
    kind: z.enum(AUDIT_KINDS).optional().describe('result(결과보고서, 기본) 또는 correction(처리결과보고서)'),
    year: z.number().int().min(2000).max(2100).optional().describe('감사 연도'),
    query: z.string().optional().describe('목록 거르기: 위원회명·제목·소관기관 일부, 예: 행정안전, 해양수산부'),
    doc_id: z.string().optional().describe('목록의 doc_id(r-… 결과보고서, c-… 처리결과보고서)'),
    section: z.enum(['all', 'corrections']).optional().describe('결과보고서 본문 시작 위치, 기본 all'),
    find: z.string().optional().describe('본문 검색어(최대 30건)'),
    offset: z.number().int().min(0).optional().describe('본문 시작 위치(next_offset 또는 find 결과의 offset)'),
    max_chars: z.number().int().min(1000).max(200000).optional().describe('본문 상한, 기본 30000'),
    limit: z.number().int().min(1).max(400).optional().describe('목록 개수, 기본 50'),
  },
  (a) => auditReports(a),
);

tool(
  'assembly_publications',
  '국회 소속기관 발간물 검색(법제실·입법조사처·예산정책처·미래연구원·국회도서관). 제목·구분은 부분일치, 결과는 작성일 최신순. ' +
    '입법조사처 "이슈와 논점"·예산정책처 "NABO Focus"·도서관 "최신외국입법정보" 같은 구분명은 div 로 거른다.',
  {
    query: z.string().optional().describe('제목 검색어'),
    source: z.enum(['all', ...Object.keys(PUBLICATION_SOURCES)]).optional().describe('기관, 기본 all'),
    div: z.string().optional().describe('발간물 구분 검색어, 예: 이슈와 논점, NABO Focus'),
    from: date.optional().describe('작성일 시작'),
    to: date.optional().describe('작성일 끝'),
    limit: z.number().int().min(1).max(300).optional().describe('기본 30'),
  },
  (a) => searchPublications(a),
);

tool(
  'assembly_votes',
  '본회의 표결: 의안별 찬반 집계와 정당별·의원별 표결.',
  {
    bill_id: z.string().describe('의안ID(PRC_…)'),
    member: z.string().optional(),
    party: z.string().optional(),
  },
  (a) => billVotes(a),
);

tool(
  'assembly_schedule',
  '국회 일정 통합(본회의·위원회·국회행사·세미나).',
  {
    date: z
      .string()
      .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'YYYY-MM-DD, YYYY-MM 또는 YYYY')
      .refine((d) => d.length !== 10 || isRealDay(d), '달력에 없는 날짜입니다')
      .describe('YYYY-MM-DD, YYYY-MM 또는 YYYY. 결과가 15만 자를 넘으면(연 단위 전체 등) 오류이니 달로 나누거나 kind·committee 로 좁힌다'),
    kind: z.string().optional().describe('일정종류, 예: 국회행사, 위원회'),
    committee: z.string().optional(),
  },
  (a) => schedule(a),
);

tool(
  'assembly_live',
  '국회 의사중계 현재 중계 목록.',
  { only_live: z.boolean().optional().describe('중계 중인 것만') },
  (a) => liveList({ onlyLive: a.only_live }),
);

tool(
  'assembly_live_captions_record',
  '의사중계 AI 자막 녹화 시작/상태. 자막 서버는 접속 이후 문장만 보내므로 회의 전체를 보려면 중계 중에 미리 녹화해야 한다. ' +
    '녹화기는 이 서버와 별도 프로세스로 돌고, 중계가 끝나면 스스로 멈춘다. xcode 는 assembly_live 의 xcode, all=true 면 모든 자막 중계를 녹화한다. 인자 없이 부르면 상태만 본다.',
  {
    xcode: z.array(z.string()).optional().describe('녹화할 방송 xcode 목록'),
    all: z.boolean().optional().describe('지금·앞으로 중계되는 자막 방송 전부'),
  },
  (a) => startRecorder({ xcodes: a.xcode, all: a.all }),
);

tool(
  'assembly_live_captions',
  '녹화된 의사중계 AI 자막(STT)을 질의 의원 블록으로 묶어 준다. 블록마다 의원·정당·지역구와 transcript("[시각] (역할?) 문장")가 붙는다. ' +
    '회의록이 나오기 전 당일 발언 원문용. 화자는 위원장 지명·자기소개 문장으로 추정한 값이고 자막에는 인식 오류가 있다. ' +
    '위원장이 부른 이름이 의원 명단에 없으면(STT 오인식) member 는 null, heard 는 자막에 들린 이름이다.',
  {
    date: date.optional().describe('녹화 날짜(기본 오늘, KST)'),
    xcode: z.string().optional(),
    committee: z.string().optional().describe('중계명 일부, 예: 성평등가족위'),
    member: z.string().optional().describe('이 의원 블록만'),
    from: hhmm.optional().describe('HH:MM 부터'),
    to: hhmm.optional().describe('HH:MM 까지'),
    max_chars: z.number().int().min(2000).max(200000).optional().describe('전체 원문 상한, 기본 40000'),
  },
  (a) => liveCaptions({ date: a.date, xcode: a.xcode, committee: a.committee, member: a.member, from: a.from, to: a.to, maxChars: a.max_chars }),
);

tool(
  'assembly_search',
  '통합 전문 검색. (1) 로컬 색인: 이 MCP 로 한 번이라도 가져온 회의록 발언·자막 녹화·검토보고서·국감 결과보고서 본문을 날짜와 상관없이 찾는다. ' +
    '띄어쓰기는 무시하고(전세사기=전세 사기), 낱말은 모두 들어 있어야 한다. "따옴표"로 묶으면 한 낱말. ' +
    '(2) remote: 국회도서관 회의록 전문 검색으로 가져온 적 없는 회의까지 찾는다(형태소 검색이라 낱말이 나뉘어 일치할 수 있음). ' +
    '기본 auto 는 로컬이 0건일 때만 원격을 본다. 근거를 인용할 때는 hit 의 url·offset 으로 원문을 열어 확인한다.',
  {
    query: z.string().min(1).describe('검색어. 공백으로 나눈 낱말 AND, "구절"'),
    sources: z.array(z.enum(INDEX_SOURCES)).optional().describe('minutes 회의록, caption 자막, bill_report 의안 보고서, audit_report 국감 보고서'),
    from: date.optional().describe('문서 날짜 시작(국감 보고서는 날짜가 없어 빠진다)'),
    to: date.optional(),
    committee: z.string().optional().describe('위원회명 일부'),
    speaker: z.string().optional().describe('발언자 이름 일부(회의록·자막)'),
    order: z.enum(['relevance', 'date']).optional().describe('기본 relevance'),
    limit: z.number().int().min(1).max(100).optional().describe('기본 20'),
    offset: z.number().int().min(0).optional().describe('로컬 결과 다음 쪽(next_offset)'),
    remote: z.enum(['auto', 'on', 'off', 'only']).optional().describe('국회도서관 원격 검색, 기본 auto'),
    remote_page: z.number().int().min(1).optional().describe('원격 결과 쪽(10건씩)'),
    remote_detail: z.number().int().min(0).max(10).optional().describe('일치 발언을 열어 볼 원격 회의 수, 기본 3'),
  },
  (a) => assemblySearch(a),
);

tool(
  'assembly_index',
  '로컬 검색 색인 관리. status: 출처별 문서·조각 수와 최근 색인 문서. meetings: 기간(최대 62일)·위원회의 공개된 회의록을 한꺼번에 색인(이미 있으면 건너뜀, force 면 다시). ' +
    'captions: 그날 자막 녹화를 색인. 회의록·자막·보고서 도구를 쓰면 자동으로도 색인된다.',
  {
    action: z.enum(['status', 'meetings', 'captions']).optional().describe('기본 status'),
    from: date.optional().describe('meetings: 시작일'),
    to: date.optional().describe('meetings: 종료일'),
    committee: z.string().optional().describe('meetings: 위원회명 일부'),
    force: z.boolean().optional().describe('meetings: 이미 색인된 회의도 다시'),
    date: date.optional().describe('captions: 녹화 날짜(기본 오늘)'),
    xcode: z.string().optional().describe('captions: 이 방송만'),
  },
  async (a) => {
    if (a.action === 'meetings') {
      if (!a.from) throw new Error('meetings 에는 from 이 필요합니다');
      return indexMeetings({ from: a.from, to: a.to, committee: a.committee, force: a.force });
    }
    if (a.action === 'captions') return indexCaptions({ date: a.date, xcode: a.xcode });
    return { ...indexStats(), recent: listDocs({ limit: 15 }) };
  },
);

tool(
  'assembly_openapi',
  `열린국회정보 OpenAPI 범용 호출. 아래 서비스ID와 요청 변수(*는 필수)를 쓴다.\n${SERVICE_LIST}`,
  {
    service: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    page: z.number().int().min(1).optional(),
    size: z.number().int().min(1).max(1000).optional(),
  },
  async (a) => {
    const res = await callOpenApi(a.service, a.params ?? {}, { pIndex: a.page ?? 1, pSize: a.size ?? 100 });
    // 큰 행 1000개는 수 MB 라 대화에 넣기 어렵다. 10만 자 안으로 줄이고 알린다
    const LIMIT = 100000;
    let rows = res.rows;
    while (rows.length > 1 && JSON.stringify(rows).length > LIMIT) rows = rows.slice(0, Math.floor(rows.length * 0.8));
    if (rows.length === res.rows.length) return res;
    return { ...res, rows, note: `응답이 커서 ${res.rows.length}행 가운데 앞 ${rows.length}행만 돌려줍니다. size 를 ${rows.length} 이하로 두고 page 로 나눠 받으세요.` };
  },
);

server.registerPrompt(
  'summarize_committee_speeches',
  {
    description: '상임위 회의 하나를 의원별 질의 요지로 정리한다(공개된 회의록 기준).',
    argsSchema: {
      confer_num: z.string().regex(/^\d+$/, '회의번호는 숫자입니다').describe('회의번호'),
      members: z.string().optional().describe('쉼표로 구분한 의원 이름(없으면 전원)'),
    },
  },
  ({ confer_num, members }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `assembly_meeting_speeches 도구로 회의 ${confer_num} 의 발언을 가져와` +
              (members ? ` (members: ${members})` : '') +
              ' 의원별로 정리해 줘. include_chair 는 false 로 불러.',
            '',
            '형식(의원마다 하나씩, 발언 순서대로):',
            '### 이름 (정당 · 지역구)',
            '- 질의 요지 3~5개. 한 줄에 하나, "무엇을 지적·요구했는지"를 구체 수치·고유명사와 함께',
            '- 답변자가 있으면 핵심 답변을 "→ 답변:" 으로 한 줄',
            '#해시태그 2~4개 (이슈 키워드)',
            '',
            '규칙:',
            '- 원문에 없는 내용을 만들지 말 것. truncated=true 인 의원은 잘린 원문 기준이라고 표시',
            '- 의사진행·인사말 같은 절차 발언만 있는 의원은 "절차 발언" 한 줄로',
            '- 맨 위에 회의명·날짜·안건과 출처 URL, 임시회의록(provisional) 여부를 적을 것',
          ].join('\n'),
        },
      },
    ],
  }),
);

server.registerPrompt(
  'summarize_meeting',
  {
    description: '상임위 회의 하나를 회의 단위로 요약한다(개요·핵심 논의사항·안건 처리·주제 태그·참석자·분량).',
    argsSchema: {
      confer_num: z.string().regex(/^\d+$/, '회의번호는 숫자입니다').describe('회의번호'),
      date: date.optional().describe('회의일 YYYY-MM-DD(알면 안건명을 회의록 목록에서 가져온다)'),
      committee: z.string().optional().describe('위원회명 일부(date 와 함께)'),
    },
  },
  ({ confer_num, date: day, committee }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `assembly_meeting_speeches 도구로 회의 ${confer_num} 를 max_chars_per_member 2000 으로 가져와(답변 없이) 회의 전체를 요약해 줘.`,
            day
              ? `안건명은 assembly_committee_meetings(from: ${day}${committee ? `, committee: ${committee}` : ''}) 결과에서 confer_num ${confer_num} 의 agendas 로 확인해. 이름 앞 번호가 의사일정 항 번호다.`
              : '안건명은 위원장의 "의사일정 제N항 … 상정" 발언에서 확인해.',
            '주의: transcript 의 "[안건N]" 은 회의록 구간 번호라 의사일정 항 번호와 다르다([안건0] 은 개회, 여러 항을 함께 상정하면 한 구간). 안건과 발언은 위원장의 상정 문장으로 짝지어.',
            '위원장(position 이 위원장인 의원)은 2000자에서 잘리면 끝부분의 가결·채택·산회 선포가 빠지니, 위원장만 members 로 다시 불러 잘리지 않은 원문으로 안건 처리를 확인해.',
            '핵심 논의사항 중 정부·증인 답변이 결론에 필요한 2~3개만 assembly_meeting_speeches 를 members 로 좁혀 다시 불러 답변을 확인해(전원 답변을 한 번에 받지 말 것).',
            '',
            '형식:',
            '## 회의명 (임시회의록이면 표시)',
            '- 날짜 · 위원회 · 출처 URL',
            '- 분량: 전체 발언 차례 수(정부·증인 포함), 발언 의원 수, 의원별 원문 글자 수 합(total_chars)',
            '',
            '### 한눈에 보기',
            '3~5문장. 무엇을 다뤘고 무엇이 쟁점이었고 어떻게 끝났는지.',
            '',
            '### 핵심 논의사항',
            '쟁점마다:',
            '#### 쟁점 이름',
            '- 제기: 의원 이름(정당) — 구체 지적·수치·요구 (여러 의원이면 각자)',
            '- 정부·증인: 답변 요지 (확인 안 했으면 "답변 미확인")',
            '- 결과: 약속·자료요구·추후 보고 등 (없으면 생략)',
            '',
            '### 안건 처리',
            '의사일정 항마다 처리 결과(가결·계류·보고·청문 실시 등). 원문의 위원장 선포 문장 근거로만 적고, 근거가 없으면 "원문에서 확인 안 됨".',
            '',
            '### 주제 태그',
            '#태그 5~8개',
            '',
            '### 참석자',
            '- 발언 의원: 정당별로 묶어 이름 나열',
            '- 정부·증인: non_members 의 이름 직위(발언 차례 수)',
            '',
            '규칙:',
            '- 원문에 없는 내용을 만들지 말 것. truncated=true 의원의 내용은 잘린 원문 기준',
            '- 수치·날짜·직접 인용은 받아 온 원문에 그대로 있는 것만 쓸 것. 비슷한 수치를 합치거나(예: 과장 25자리 중 14명 검찰 출신 ≠ 24자리 중 16자리 공석) 의원 질문을 후보자 답변으로 옮기지 말 것',
            '- 답변을 다시 불러 확인하지 않은 쟁점에서 후보자·증인이 약속했다고 쓰지 말 것',
            '- 여야 구도는 정당 필드로만 판단하고, 의원 성향을 추측해 붙이지 말 것',
            '- 의원별 상세 질의는 summarize_committee_speeches 의 몫이다. 여기서는 쟁점 단위로 묶을 것',
          ].join('\n'),
        },
      },
    ],
  }),
);

server.registerPrompt(
  'summarize_live_captions',
  {
    description: '녹화된 당일 중계 AI 자막을 질의 의원별 요지로 정리한다(회의록 공개 전용).',
    argsSchema: {
      committee: z.string().describe('중계명 일부, 예: 성평등가족위'),
      date: date.optional().describe('YYYY-MM-DD, 기본 오늘'),
    },
  },
  ({ committee, date: day }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `assembly_live_captions 도구로 ${day ?? '오늘'} "${committee}" 녹화 자막을 가져와 질의 의원별로 정리해 줘.`,
            '',
            '형식(블록 순서대로):',
            '### 이름 (정당 · 지역구) — 시각 범위, 추정 근거(위원장 지명/자기소개)',
            '- 질의 요지 3~5개, 답변 핵심은 "→ 답변:" 한 줄',
            '#해시태그 2~4개',
            '',
            '규칙:',
            '- AI 음성인식 자막이다. 숫자·고유명사가 문맥상 어색하면 "(자막 불확실)" 을 붙이고 고쳐 쓰지 말 것',
            '- member 가 null 인 블록은 "질의자 미확인" 으로 두고, 문맥만으로 이름을 지어내지 말 것. heard 가 있으면 "질의자 미확인(자막상 ○○○, 명단에 없음)" 으로 들린 그대로 적고 비슷한 위원 이름으로 고치지 말 것',
            '- 블록 안에도 위원장 발언·답변이 섞여 있다. (진행?) 줄과 위원장 마무리 발언은 그 의원의 질의로 옮기지 말 것',
            '- 맨 위에 중계명·안건·녹화 시간 범위와 "공식 회의록 아님" 을 적을 것',
          ].join('\n'),
        },
      },
    ],
  }),
);

const shutdown = async () => {
  await closeBrowser().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
