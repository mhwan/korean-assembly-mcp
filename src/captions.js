// 의사중계 AI 자막(STT) 녹화 파일 관리와 화자 추정
//
// 자막 서버: live_play.asp 의 xsami(예: wss://smiai.webcast.go.kr:8091/aistt/woman) + "/hls", 서브프로토콜 echo-protocol.
// 접속한 뒤의 프레임만 오고 지난 구간은 다시 보내지 않으므로, 회의 전체를 보려면 중계 중에 녹화해 둬야 한다.
// 프레임: {segment, segment-offset, segment-duration, send-timestamp, final, scd, transcript, transcripts:[[flag, text]]}
//  - final=false: 인식 중인 문장(계속 길어진다)
//  - final=true, scd=false: 문장 확정
//  - final=true, scd=true: 화자 분리 결과. transcripts 를 화자 조각으로 나누고, "- " 로 시작하는 조각이 화자 전환,
//    flag 0/1 은 전환마다 번갈아 붙는 색 구분(같은 사람이라는 뜻이 아님)
// 화자 이름은 프레임에 없다. 위원장 진행 발언("○○○ 위원님 질의해 주십시오")과 자기소개로 질의 의원을 추정한다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './browser.js';
import { isLive } from './domains.js';
import { allMembers } from './members.js';
import { autoSave } from './search-index.js';

export const CAPTION_DIR = process.env.ASSEMBLY_CAPTION_DIR ?? join(homedir(), '.cache', 'assembly-mcp', 'captions');
const SERVICE = 'https://assembly.webcast.go.kr/main/service/';

export const kstDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
export const kstTime = (d = new Date()) => d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' });
const kstStamp = (iso) => (iso ? `${kstDate(new Date(iso))} ${kstTime(new Date(iso))} KST` : null);

export function captionDir(date = kstDate()) {
  const dir = join(CAPTION_DIR, date);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const broadcastKey = (t) => `${t.xcode}_${t.xcgcd || 'none'}`;

/** 지금 중계 중이고 AI 자막(xsami=1)이 있는 방송. 자막 주소와 안건을 함께 가져온다. */
export async function liveTargets({ xcodes } = {}) {
  const list = await fetchJson(`${SERVICE}live_list.asp`);
  const on = (list.xlist ?? []).filter((x) => isLive(x) && (!xcodes?.length || xcodes.includes(String(x.xcode))));
  const out = [];
  for (const x of on) {
    const q = new URLSearchParams({ xcode: x.xcode, xcgcd: x.xcgcd ?? '' }).toString();
    const play = await fetchJson(`${SERVICE}live_play.asp?${q}`).catch(() => null);
    const ws = play?.xsami;
    if (!ws?.startsWith('wss://')) continue; // AI 자막 없는 방송
    const angun = await fetchJson(`${SERVICE}live_angun.asp?${q}`).catch(() => null);
    out.push({
      xcode: String(x.xcode),
      xcgcd: x.xcgcd ?? '',
      name: x.xname,
      subject: play.xsubj ?? x.xsubj,
      status: x.xdesc,
      agendas: (angun?.angun?.[0]?.xlist ?? []).map((a) => a.billname).filter(Boolean),
      ws: `${ws}/hls`,
    });
  }
  return out;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 녹화기(src/caption-recorder.js)를 이 서버와 떨어진 프로세스로 띄우고, 녹화 상태를 돌려준다. */
export async function startRecorder({ xcodes, all } = {}) {
  captionDir();
  const started = [];
  if (all || xcodes?.length) {
    const argv = all ? ['--all'] : xcodes;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./caption-recorder.js', import.meta.url)), ...argv], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // Windows 에서 detached 자식이 콘솔 창을 띄우지 않게
    });
    child.unref();
    started.push({ pid: child.pid, args: argv });
    await new Promise((r) => setTimeout(r, 8000)); // 첫 목록 조회·접속까지
  }
  const recorders = readdirSync(CAPTION_DIR)
    .filter((f) => /^recorder-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(CAPTION_DIR, f), 'utf8')))
    .filter((r) => alive(r.pid));
  const today = recordings().map((r) => ({
    xcode: r.xcode,
    name: r.name,
    subject: r.subject,
    started: r.started,
    updated: r.updated,
    lines: existsSync(r.file) ? readFileSync(r.file, 'utf8').split('\n').length - 1 : 0,
  }));
  return { started, running: recorders, today, dir: CAPTION_DIR };
}

/** 녹화 파일 목록(날짜별 디렉터리의 {xcode}_{xcgcd}.meta.json) */
export function recordings(date = kstDate()) {
  const dir = join(CAPTION_DIR, date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { ...meta, file: join(dir, f.replace('.meta.json', '.jsonl')) };
    });
}

/** 녹화 파일 → 구간(segment)별 최종 텍스트. 화자 분리(scd) 결과를 우선하고, 없으면 확정 문장을 쓴다. */
function loadSegments(file) {
  if (!existsSync(file)) return [];
  const bySeg = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue; // 녹화 중 마지막 줄이 덜 써졌을 수 있다
    }
    const prev = bySeg.get(f.seg);
    if (prev?.scd && !f.scd) continue;
    bySeg.set(f.seg, f);
  }
  return [...bySeg.values()].sort((a, b) => a.seg - b.seg);
}

const CHAIR = /질의(를)?\s*(해\s*)?주(시기|십시오|시겠습니까)|질의하(시겠습니다|도록 하겠습니다)|수고(하셨습니다|많으셨습니다)|다음(은|으로)?\s*[가-힣]{2,4}\s*위원|감사를 (계속|중지|속개)|정회(를)? 선포|속개하겠습니다|발언 시간/;
// 피감기관은 "저희가 …하겠습니다", 의원은 "장관님 …니까?" 로 말하는 경향을 쓴다
const ANSWER = /^(네|예|아 네|그렇습니다|맞습니다|위원님)[\s,.]|(검토하겠습니다|노력하겠습니다|살펴보겠습니다|점검해 보겠습니다|말씀드리(겠습니다|면)|보고드리|파악하고 있습니다|그렇게 하겠습니다)|^저희(가|는|도)\s|(?<!부탁)(드리|하|보)겠습니다[\s.]*$/;
const QUESTION = /(장관님|차관님|원장님|청장님|이사장님|사장님|대표님|본부장님|처장님|실장님|센터장님|위원장님께)|(니까|잖아요|지요|죠|세요|십시오)[\s?.]*$/;

/** 이름 후보를 위원회 위원 명단에 맞춘다. 3글자 이상이면 STT 가 한 글자 틀리는 경우까지 받는다(같은 길이, 1글자 차이, 후보가 하나일 때만). */
function matchName(raw, roster) {
  if (roster.has(raw)) return raw;
  if (raw.length < 3) return null;
  const near = [...roster].filter((n) => n.length === raw.length && [...n].filter((c, i) => c !== raw[i]).length === 1);
  return near.length === 1 ? near[0] : null;
}

// "○○○ 위원님 질의해 주십시오", "다음은 ○○○ 위원님", "○○○ 위원입니다", "○○○ 위원님 수고하셨습니다"
// "곽상언 위원님 질의에 제가 답변을…" 같은 언급은 지명이 아니다
// "김소희 위원님 3분이십니다 질의해 주세요" 처럼 시간 안내가 끼는 경우도 지명이다
const CALL_AFTER = /^\s*(님)?\s*(\d+\s*분\S*\s*)?(질의|발언|보충\s*질의|말씀)\s*(해|하시|하도록|부탁)/;
const CALL_BEFORE = /(다음(은|으로|에는)?|이어서|계속해서)\s*$/;
const INTRO_AFTER = /^\s*입니다/;
const CLOSE_AFTER = /^\s*(님)?\s*수고/;

/**
 * 문장 안의 의원 단서. call: 이 의원 차례 시작, close: 앞 블록이 이 의원 차례였음.
 * 위원회 명단 → 전체 의원 명단 순으로 맞추고, 어디에도 없는 이름의 지명은 name=null 과 들은 이름(heard)으로 남긴다
 * (STT 가 "손솔"을 "손설호"로 들으면 앞 의원 블록에 다음 의원 질의가 섞이므로 블록은 끊는다).
 */
function findCues(text, roster) {
  const cues = [];
  for (const m of text.matchAll(/([가-힣]{2,4})\s*(위원|의원|간사)/g)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const how = INTRO_AFTER.test(after)
      ? '자기소개'
      : CALL_AFTER.test(after) || CALL_BEFORE.test(before)
        ? '위원장 지명'
        : CLOSE_AFTER.test(after)
          ? '위원장 마무리'
          : null;
    if (!how) continue;
    const name = matchName(m[1], roster.committee) ?? matchName(m[1], roster.all);
    if (name) cues.push({ name, how });
    else if (how === '위원장 지명') cues.push({ name: null, heard: m[1], how: '위원장 지명(명단에 없는 이름)' });
  }
  return cues;
}

function roleOf(text) {
  if (CHAIR.test(text)) return '진행';
  const q = QUESTION.test(text);
  const a = ANSWER.test(text);
  if (q && a) return /장관님|차관님|원장님|청장님|이사장님|사장님|대표님|본부장님|처장님|실장님|센터장님/.test(text) ? '질의' : '답변';
  return q ? '질의' : a ? '답변' : null;
}

/** 구간 → 화자 차례. "- " 조각에서 화자가 바뀌되, 6자 미만 조각은 화자 분리 잡음으로 보고 앞 차례에 붙인다. */
function buildTurns(segments) {
  const turns = [];
  let cur = null;
  for (const s of segments) {
    for (const [, raw] of s.pieces) {
      let text = String(raw ?? '').trim();
      const change = text.startsWith('-');
      if (change) text = text.replace(/^-\s*/, '');
      if (!text) continue;
      if (!cur || (change && text.length >= 6)) {
        cur = { time: s.ts?.slice(11, 19), seg: s.seg, text };
        turns.push(cur);
      } else {
        cur.text += ` ${text}`;
      }
    }
  }
  return turns;
}

const committeeOf = (name) => (name ?? '').replace(/위$/, '위원회');

async function rosterFor(committeeName) {
  const full = committeeOf(committeeName);
  const rows = await allMembers();
  const inCommittee = rows.filter((m) => full && m.CMITS?.includes(full));
  // 국정감사·특위는 다른 위원회 의원도 나오므로 전원 명단을 뒤에 둔다
  return {
    committee: new Map(inCommittee.map((m) => [m.HG_NM, m])),
    all: new Map(rows.map((m) => [m.HG_NM, m])),
  };
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…(${s.length - n}자 생략)` : s);

/** 차례 → 질의 의원 블록. 지명·자기소개가 나올 때마다 새 블록. 위원회 명단을 먼저 보고, 없으면 전체 의원 명단 */
function captionBlocks(turns, roster) {
  const names = { committee: new Set(roster.committee.keys()), all: new Set(roster.all.keys()) };
  const blocks = [];
  let block = { member: null, how: null, start: turns[0]?.time, turns: [] };
  blocks.push(block);
  for (const t of turns) {
    const cues = findCues(t.text, names);
    let role = roleOf(t.text);
    for (const cue of cues) {
      if (cue.how === '위원장 마무리') {
        // "○○○ 위원님 수고하셨습니다": 이름 없는 앞 블록을 채운다
        if (!block.member) Object.assign(block, { member: cue.name, how: cue.how });
        role = '진행';
      } else if (!cue.name || cue.name !== block.member) {
        // 위원장이 다음 의원을 부르는 문장은 그 의원 블록의 첫 줄로 넣는다
        block = { member: cue.name, heard: cue.heard, how: cue.how, start: t.time, turns: [] };
        blocks.push(block);
        if (cue.how === '위원장 지명') role = '진행';
      }
    }
    block.turns.push({ ...t, role });
  }
  return blocks.filter((b) => b.turns.length);
}

// 녹화 한 건을 차례 단위로 색인에 넣는다. speaker 는 추정한 질의 의원 블록(차례의 실제 화자가 아닐 수 있다)
function indexRecording(date, r, blocks) {
  return autoSave({
    source: 'caption',
    key: `${date}/${broadcastKey(r)}`,
    title: [r.name, r.subject].filter(Boolean).join(' '),
    date,
    committee: committeeOf(r.name),
    url: null,
    meta: { xcode: r.xcode, xcgcd: r.xcgcd, file: r.file, recorded_until: r.updated },
    chunks: blocks.flatMap((b) =>
      b.turns.map((t) => ({
        speaker: b.member ? `${b.member}(추정 블록)` : null,
        section: `${t.time ?? ''}${t.role ? ` ${t.role}?` : ''}`,
        text: t.text,
      })),
    ),
  });
}

/** 그날 녹화 전부(또는 xcode 하나)를 색인에 넣는다 */
export async function indexCaptions({ date = kstDate(), xcode } = {}) {
  const recs = recordings(date).filter((r) => !xcode || r.xcode === String(xcode));
  const results = [];
  for (const r of recs) {
    const blocks = captionBlocks(buildTurns(loadSegments(r.file)), await rosterFor(r.name));
    const turns = blocks.reduce((n, b) => n + b.turns.length, 0);
    results.push({ key: `${date}/${broadcastKey(r)}`, name: r.name, turns, status: indexRecording(date, r, blocks) });
  }
  return { date, recordings: results.length, results };
}

/**
 * 녹화된 자막을 질의 의원 블록으로 묶어 돌려준다.
 * - xcode 또는 committee(중계명 일부)로 방송을 고른다. 없으면 그날 녹화 전부
 * - member: 이 의원 블록만
 * - from/to: HH:MM (KST)
 */
export async function liveCaptions({ date = kstDate(), xcode, committee, member, from, to, maxChars = 40000 } = {}) {
  const recs = recordings(date).filter(
    (r) => (!xcode || r.xcode === String(xcode)) && (!committee || r.name?.includes(committee)),
  );
  if (!recs.length) {
    return { date, recordings: [], note: '이 날짜에 녹화된 자막이 없습니다. 중계 중에 assembly_live_captions_record 로 녹화를 시작해야 합니다(지난 구간은 서버가 다시 보내지 않음).' };
  }
  const out = [];
  for (const r of recs) {
    const roster = await rosterFor(r.name);
    const all = captionBlocks(buildTurns(loadSegments(r.file)), roster);
    const index = indexRecording(date, r, all);
    // 블록은 녹화 전체로 묶은 뒤 시간으로 자른다(앞에서 지명된 의원 블록이 from 이후로 이어질 수 있다)
    const inRange = (t) => (!from || t.time >= from) && (!to || t.time <= `${to}:59`);
    const nonEmpty = all
      .map((b) => ({ ...b, turns: b.turns.filter(inRange) }))
      .filter((b) => b.turns.length)
      .map((b) => ({ ...b, start: b.turns[0].time }));
    const turns = nonEmpty.flatMap((b) => b.turns);
    const picked = member ? nonEmpty.filter((b) => b.member === member) : nonEmpty;
    const total = picked.reduce((n, b) => n + b.turns.reduce((k, t) => k + t.text.length, 0), 0);
    const ratio = Math.min(1, maxChars / Math.max(1, total));
    out.push({
      xcode: r.xcode,
      xcgcd: r.xcgcd,
      name: r.name,
      subject: r.subject,
      agendas: r.agendas,
      // 녹화 파일엔 UTC ISO 로 남지만 자막 시각(time)이 KST 라 맞춰 보여준다
      recorded_from: kstStamp(r.started),
      recorded_until: kstStamp(r.updated),
      index,
      turn_count: turns.length,
      total_chars: total,
      truncated: ratio < 1,
      blocks: picked.map((b) => {
        const m = b.member ? roster.committee.get(b.member) ?? roster.all.get(b.member) : null;
        return {
          member: b.member,
          // 위원장이 부른 이름이 명단에 없을 때 자막에 들린 그대로(STT 오인식일 수 있어 실제 이름이 아님)
          ...(b.heard ? { heard: b.heard } : {}),
          party: m?.POLY_NM ?? null,
          district: m?.ORIG_NM ?? null,
          identified_by: b.how,
          start: b.start,
          end: b.turns.at(-1)?.time,
          // 한 줄에 한 차례: "[17:05:24] (답변?) 문장". 괄호는 문장 모양으로 추정한 역할
          transcript: b.turns
            .map((t) => {
              const text = ratio < 1 ? cut(t.text, Math.max(80, Math.floor(t.text.length * ratio))) : t.text;
              return `[${t.time}]${t.role ? ` (${t.role}?)` : ''} ${text}`;
            })
            .join('\n'),
        };
      }),
    });
  }
  return {
    date,
    caution:
      'AI 음성인식 자막이라 오탈자·숫자 오류가 있고, 화자 이름은 자막에 없다. member 는 위원장 지명·자기소개 문장으로 추정한 질의 의원, (질의?/답변?/진행?) 은 문장 모양으로 추정한 역할이다. 공식 기록은 약 1주 뒤 assembly_meeting_speeches 로 확인한다.',
    recordings: out,
  };
}
