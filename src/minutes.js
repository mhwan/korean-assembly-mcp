// 위원회 회의 찾기(OpenAPI)와 회의록 전문(record.assembly.go.kr) 의원별 정리
import { fetchText } from './browser.js';
import { findMember } from './members.js';
import { callOpenApiAll } from './openapi.js';
import { autoSave, hasDoc } from './search-index.js';

const RECORD = 'https://record.assembly.go.kr/assembly/viewer/minutes/xml.do';

function* days(from, to) {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to ?? from}T00:00:00Z`);
  for (let i = 0; d <= end && i < 62; i++, d.setUTCDate(d.getUTCDate() + 1)) yield d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD 가 달력에 있는 날인가. 2026-02-30 처럼 없는 날은 Date 가 다음 달로 넘기므로 되돌려 비교한다 */
export function isRealDay(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** 위원회 회의록 목록. 안건마다 따로 오는 행을 CONFER_NUM 으로 묶는다. */
export async function committeeMeetings({ from, to, committee, age = 22 }) {
  // 날짜별로 OpenAPI 를 부르므로 기간을 62일로 막는다. 넘으면 조용히 자르지 않고 알린다
  for (const d of [from, to]) if (d && !isRealDay(d)) throw new Error(`없는 날짜입니다: ${d}`);
  const span = (Date.parse(to ?? from) - Date.parse(from)) / 86400000;
  if (span < 0) throw new Error(`종료일이 시작일보다 앞입니다: ${from} ~ ${to}`);
  if (span >= 62) throw new Error(`기간은 최대 62일입니다(${from} ~ ${to} 는 ${span + 1}일). 나눠서 조회하세요.`);
  const byNum = new Map();
  for (const date of days(from, to)) {
    const { rows } = await callOpenApiAll('ncwgseseafwbuheph', { DAE_NUM: age, CONF_DATE: date });
    for (const r of rows) {
      if (committee && !r.COMM_NAME?.includes(committee)) continue;
      let m = byNum.get(r.CONFER_NUM);
      if (!m) {
        m = {
          confer_num: r.CONFER_NUM,
          conf_id: r.CONF_ID,
          title: r.TITLE,
          committee: r.COMM_NAME,
          class: r.CLASS_NAME,
          date: r.CONF_DATE,
          agendas: [],
          minutes_url: `${RECORD}?id=${r.CONFER_NUM}&type=view`,
          video_url: r.VOD_LINK_URL,
          pdf_url: r.PDF_LINK_URL,
        };
        byNum.set(r.CONFER_NUM, m);
      }
      if (r.SUB_NAME && !m.agendas.includes(r.SUB_NAME)) m.agendas.push(r.SUB_NAME);
    }
  }
  for (const m of await auditMeetings({ from, to: to ?? from, committee, age })) if (!byNum.has(m.confer_num)) byNum.set(m.confer_num, m);
  return [...byNum.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 국정감사 회의록(VCONFAPIGCONFLIST). 위원회 회의록 목록(ncwgseseafwbuheph)엔 국감이 없다.
 * 날짜 인자가 먹지 않아 대수 전체(수백 건)를 받아 거른다. DOWN_URL 의 id 가 xml.do 회의록 id 와 같다.
 */
async function auditMeetings({ from, to, committee, age }) {
  const { rows } = await callOpenApiAll('VCONFAPIGCONFLIST', { ERACO: `제${age}대` }, { max: 3000 });
  return rows
    .filter((r) => r.CONF_DT >= from && r.CONF_DT <= to && (!committee || r.CMIT_NM?.includes(committee)))
    .map((r) => {
      const id = /[?&]id=(\d+)/.exec(r.DOWN_URL ?? '')?.[1];
      return id && {
        confer_num: Number(id), // 위원회 회의록 API 의 CONFER_NUM 과 같은 숫자형
        video_url: null,
        conf_id: r.CONF_ID,
        title: `제${age}대 ${r.SESS ?? ''} 국정감사 ${r.CMIT_NM} (${r.CONF_DT})`,
        committee: r.CMIT_NM,
        class: r.CONF_KND ?? '국정감사 회의록',
        date: r.CONF_DT,
        agendas: [],
        minutes_url: `${RECORD}?id=${id}&type=view`,
        pdf_url: r.DOWN_URL,
      };
    })
    .filter(Boolean);
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', hellip: '…' };
function cleanText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

const attr = (s, name) => new RegExp(`${name}="([^"]*)"`).exec(s)?.[1];

/** 회의록 전문 HTML → 발언 순서대로 [{order, agenda, mem_id, name, position, district, text}] */
export function parseMinutesView(html) {
  const turns = [];
  const parts = html.split(/<div id="spk_(\d+)" /);
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i + 1];
    const head = block.slice(0, block.indexOf('>'));
    const sentences = [...block.matchAll(/<span class="spk_sub"[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => cleanText(m[1]))
      .filter(Boolean);
    turns.push({
      order: Number(parts[i]),
      agenda: Number(/item(\d+)/.exec(attr(head, 'class') ?? '')?.[1] ?? 0),
      mem_id: attr(head, 'data-mem_id'),
      name: attr(head, 'data-name'),
      position: attr(head, 'data-pos'),
      district: /class="area">\(([^)]*)\)/.exec(block)?.[1],
      text: sentences.join('\n'),
    });
  }
  return turns;
}

function meetingHeader(html) {
  // 일반: "제22대국회 제439회 (정기회) 제7차 행정안전위원회", 국감: "제22대국회 2026년도 국정감사 법제사법위원회"
  const title = cleanText(/제\d+대국회 (?:제\d+회|\d{4}년도 국정감사)[^<]{0,120}/.exec(html)?.[0] ?? '');
  // 본문 첫 "2025년 3월 13일(목)" 이 회의 날짜
  const d = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*\([월화수목금토일]\)/.exec(html);
  return {
    title,
    committee: /(?:제\d+차|국정감사)\s*(.+)$/.exec(title)?.[1]?.trim() ?? null,
    date: d ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}` : null,
    provisional: html.includes('임시회의록'),
  };
}

// 회의록 발언 전부(의원·비의원)를 차례 단위로 색인에 넣는다
function indexMinutes(conferNum, header, url, turns, confId) {
  const meta = { ...(header.provisional ? { provisional: true } : {}), ...(confId ? { conf_id: confId } : {}) };
  return autoSave({
    source: 'minutes',
    key: conferNum,
    title: header.title,
    date: header.date,
    committee: header.committee,
    url,
    meta: Object.keys(meta).length ? meta : undefined,
    chunks: turns.map((t) => ({
      speaker: [t.name, t.position].filter(Boolean).join(' '),
      mem_id: isMember(t) ? t.mem_id : null,
      section: `안건${t.agenda}`,
      text: t.text,
    })),
  });
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…(${s.length - n}자 생략)` : s);
const isMember = (t) => t.mem_id && t.mem_id !== '0';

/**
 * 회의 한 건의 발언을 의원별로 묶는다.
 * - members: 이 이름들만 (없으면 전원)
 * - maxCharsPerMember: 의원별 원문 분량 상한. 발언 차례마다 고르게 나눠 자른다
 * - withReplies: 의원 발언 직후의 비의원(장관·증인 등) 답변을 붙인다
 */
export async function meetingSpeeches(conferNum, { members, maxCharsPerMember, withReplies, includeChair = true } = {}) {
  // 몇 명만 고르면 그 의원의 질의를 거의 다 볼 수 있게 상한을 넉넉히 둔다
  maxCharsPerMember ??= members?.length ? 20000 : 3000;
  const url = `${RECORD}?id=${conferNum}&type=view`;
  // 국감 회의록은 목록에 먼저 올라오고 전문은 며칠 뒤 열린다. 그 사이엔 400 이 온다
  const html = await fetchText(url, { timeoutMs: 60000 }).catch((e) => {
    if (/HTTP 400/.test(e.message)) throw new Error(`회의록 ${conferNum}: 전문이 아직 공개되지 않았습니다(국감 회의록은 목록에 먼저 오르고 전문·PDF 는 며칠 뒤 열림). 그 사이엔 assembly_speech_clips 를 쓰세요`);
    throw e;
  });
  const turns = parseMinutesView(html);
  if (!turns.length) throw new Error(`회의록 ${conferNum}: 발언 블록이 없습니다(미공개이거나 형식이 다름)`);
  const header = meetingHeader(html);
  const index = indexMinutes(conferNum, header, url, turns);
  const replies = withReplies ?? Boolean(members?.length);

  const groups = new Map();
  turns.forEach((t, idx) => {
    if (!isMember(t)) return;
    if (!includeChair && t.position === '위원장') return;
    if (members?.length && !members.includes(t.name)) return;
    const key = `${t.name}|${t.mem_id}`;
    if (!groups.has(key)) groups.set(key, { name: t.name, position: t.position, district: t.district, mem_id: t.mem_id, turns: [] });
    const g = groups.get(key);
    const entry = { agenda: t.agenda, text: t.text };
    if (replies) {
      entry.replies = [];
      for (let j = idx + 1; j < turns.length && !isMember(turns[j]); j++) {
        entry.replies.push({ speaker: `${turns[j].name} ${turns[j].position}`, text: cut(turns[j].text, 600) });
      }
    }
    g.turns.push(entry);
  });

  const out = [];
  for (const g of groups.values()) {
    const info = await findMember(g.name, g.district);
    const chars = g.turns.reduce((n, t) => n + t.text.length, 0);
    // 상한을 넘으면 차례마다 길이 비율대로 줄인다(짧은 맞장구는 거의 그대로, 긴 질의가 많이 줄어든다)
    const ratio = Math.min(1, maxCharsPerMember / chars);
    out.push({
      name: g.name,
      position: g.position,
      party: info?.POLY_NM ?? null,
      district: g.district ?? info?.ORIG_NM ?? null,
      turn_count: g.turns.length,
      total_chars: chars,
      truncated: chars > maxCharsPerMember,
      // 차례마다 "[안건N] 발언" 한 단락, 답변은 "  ↳ 이름 직위: 답변"
      transcript: g.turns
        .map((t) => {
          const text = ratio < 1 ? cut(t.text, Math.max(40, Math.floor(t.text.length * ratio))) : t.text;
          const replies = (t.replies ?? []).map((r) => `  ↳ ${r.speaker}: ${r.text}`);
          return [`[안건${t.agenda}] ${text}`, ...replies].join('\n');
        })
        .join('\n\n'),
    });
  }

  const others = new Map();
  for (const t of turns) {
    if (isMember(t)) continue;
    const k = `${t.name} ${t.position}`;
    others.set(k, (others.get(k) ?? 0) + 1);
  }
  return {
    confer_num: conferNum,
    ...header,
    source_url: url,
    turn_count: turns.length,
    index,
    members: out,
    non_members: [...others].map(([speaker, turns]) => ({ speaker, turns })),
  };
}

/**
 * 기간·위원회의 공개된 회의록을 색인에 넣는다(최대 62일). 이미 색인된 회의는 force 가 아니면 건너뛴다.
 * 회의록이 아직 안 올라온 회의는 not_ready 로 남긴다.
 */
export async function indexMeetings({ from, to, committee, force = false }) {
  const meetings = await committeeMeetings({ from, to, committee });
  const results = [];
  for (const m of meetings) {
    const base = { confer_num: m.confer_num, date: m.date, title: m.title };
    if (!force && hasDoc('minutes', m.confer_num)) {
      results.push({ ...base, status: 'skipped(already)' });
      continue;
    }
    try {
      const html = await fetchText(m.minutes_url, { timeoutMs: 60000 });
      const turns = parseMinutesView(html);
      if (!turns.length) {
        results.push({ ...base, status: 'not_ready' });
        continue;
      }
      const header = meetingHeader(html);
      // 본문에서 날짜를 못 읽으면 목록의 날짜를 쓴다
      header.date ??= m.date;
      header.committee ??= m.committee;
      results.push({ ...base, turns: turns.length, status: indexMinutes(m.confer_num, header, m.minutes_url, turns, m.conf_id) });
    } catch (e) {
      results.push({ ...base, status: `error: ${e.message}` });
    }
  }
  const count = (p) => results.filter((r) => String(r.status).startsWith(p)).length;
  return {
    meetings: results.length,
    added: count('added'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    skipped: count('skipped'),
    not_ready: count('not_ready'),
    errors: count('error'),
    results,
  };
}

/** 발언영상(npeslxqbanwkimebr): 회의 당일에도 나오는 의원별 질의 구간 목록. 원문 텍스트는 없다. */
export async function speechClips({ date, title, member, age = 22 }) {
  const { rows } = await callOpenApiAll('npeslxqbanwkimebr', { CT1: age, TAKING_DATE: date }, { max: 3000 });
  const sec = (t) => (t ?? '0:0:0').split(':').reduce((a, b) => a * 60 + Number(b), 0);
  const meetings = new Map();
  const seen = new Set();
  for (const r of rows) {
    // 원천이 똑같은 행을 두 번 주는 경우가 있다(2026-10-23: 802행 중 영상 링크 기준 717건)
    const key = r.LINK_URL ?? JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const meeting = String(r.TITLE ?? '').trim(); // 제목 끝에 \r\n 이 붙어 오는 회의가 있다
    if (title && !meeting.includes(title)) continue;
    // "김위상 위원(국민의힘)  질의 / 김영훈 장관(고용노동부)  답변"
    const parts = String(r.ESSENTIAL_PERSON ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    const m = /^(\S+)\s+(\S+?)\(([^)]*)\)\s*(.*)$/.exec(parts[0] ?? '');
    if (!m) continue;
    const [, name, position, party] = m;
    if (member && name !== member) continue;
    if (!meetings.has(meeting)) meetings.set(meeting, new Map());
    const byMember = meetings.get(meeting);
    if (!byMember.has(name)) byMember.set(name, { name, position, party, clips: 0, seconds: 0, items: [] });
    const g = byMember.get(name);
    g.clips++;
    g.seconds += sec(r.REC_TIME);
    // 첫 조각은 의원 자신이므로 빼고, 답변자만 "홍지선 장관(국토교통부)" 꼴로 남긴다
    g.items.push({ duration: r.REC_TIME, with: parts.slice(1).map((p) => p.replace(/\s+(답변|발언|질의)$/, '')), video: r.LINK_URL });
  }
  // 날짜만 주면 하루치 회의 전부라 수만 자가 되므로, 영상 구간(items)은 member 를 줬을 때만 준다
  const out = [...meetings].map(([meeting, byMember]) => ({
    meeting,
    members: [...byMember.values()].map(({ seconds, items, ...g }) => ({
      ...g,
      minutes: Math.round(seconds / 6) / 10,
      ...(member ? { items } : {}),
    })),
  }));
  if (!out.length) {
    return {
      date,
      meetings: [],
      note: rows.length
        ? '조건에 맞는 발언영상이 없습니다.'
        : '이 날짜의 발언영상이 아직 없습니다. 회의 당일 저녁~다음 날 공개되고, 회의가 없던 날도 0건입니다.',
    };
  }
  return { date, meetings: out, ...(member ? {} : { note: '영상 구간·링크는 member 를 주면 나옵니다.' }) };
}
