// 국회도서관 국회회의록 빅데이터(dataset.nanet.go.kr) 전문 검색. 제헌국회부터 모든 회의록 발언을 날짜와 상관없이 찾는다.
// - 목록: GET /meeting?searchWord=… → 회의 단위 10건씩(HTML). 회의마다 일치 화자·발언 수가 붙는다. 전체 건수는 주지 않는다.
// - 상세: GET /meeting/detail?conferNum=… → 회의 발언 전부(_contentList JSON)
// 회의 id(conf_id)는 record.assembly 회의록의 CONF_ID 와 같다(CONFER_NUM 아님). 목록은 형태소 검색이라
// "전세사기"가 전세·사기 로 나뉘어 걸린 회의도 섞일 수 있고, 상세에서 고른 일치 발언이 0건이면 그런 경우다.
import { fetchText } from './browser.js';
import { normalize, parseQuery, snippet } from './search-index.js';

const NANET = 'https://dataset.nanet.go.kr';

const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\[nrt]/g, ' ') // 상세 JSON 안 안건명에 남는 글자 그대로의 \n
    .replace(/\s+/g, ' ')
    .trim();

const count = (block, cls) => {
  const m = new RegExp(`class="fs_24 fw_700 ${cls}">\\s*([\\d,]+)\\s*<span[^>]*>\\s*/\\s*([\\d,]+)`).exec(block);
  return m ? [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))] : [null, null];
};

/** 회의 단위 검색 결과 한 쪽(10건). committee 는 위원회명 패싯(예: 국토교통위원회) */
export async function nanetSearch({ query, committee, page = 1 }) {
  const p = new URLSearchParams({ srchGb: 'total', searchWord: query, srchDisp: query, pageNo: String(page), tabGb: 'content', orgId: 'NAM' });
  if (committee) p.set('facetCommName', committee);
  const html = await fetchText(`${NANET}/meeting?${p}`, { timeoutMs: 60000 });
  const parts = html.split(/onclick="selectMeetingDetail\('/).slice(1);
  const meetings = [];
  for (const part of parts) {
    const id = /^([^']+)'/.exec(part)?.[1];
    if (!id || meetings.some((m) => m.conf_id === id)) continue;
    // 다음 회의 항목 전까지가 이 회의의 블록
    const block = part.slice(0, 6000);
    const [matchedSpeakers, totalSpeakers] = count(block, 'speaker');
    const [matchedSpeeches, totalSpeeches] = count(block, 'content');
    meetings.push({
      conf_id: id,
      title: clean(/title="([^"]*)"/.exec(block)?.[1]),
      date: /(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? null,
      matched_speeches: matchedSpeeches,
      total_speeches: totalSpeeches,
      matched_speakers: matchedSpeakers,
      total_speakers: totalSpeakers,
    });
  }
  return { query, committee: committee ?? null, page, has_more: meetings.length >= 10, meetings };
}

function detailParams(confId, q) {
  return new URLSearchParams({
    tabGb: 'content', totalCount: '0',
    'srchQList[0].srchKey': '', 'srchQList[0].srchGb': 'total', 'srchQList[0].srchIdx': 'total',
    'srchQList[0].srchQ': q, 'srchQList[0].srchDisp': q, 'srchQList[0].srchCond': 'AND',
    pageNo: '1', recordCountPerPage: '10', orgId: 'NAM', sort: 'score:desc', srchGb: 'total', srchDisp: q, srchCond: '',
    searchType: 'meeting', facetOrgSubId: '', facetDaeNum: '', facetClassCode: '', facetCommName: '', facetCommSubName: '',
    facetMeetingYear: '', facetFrequency: '', facetMemberName: '', dtl_orgId: '', dtl_orgSubId: '', dtl_daeNums: '',
    dtl_classCode: '', dtl_subClassCode: '', dtl_commNames: '', dtl_startFrequency: '', dtl_endFrequency: '',
    dtl_startMeetingDate: '', dtl_endMeetingDate: '', conferNum: confId,
  });
}

/**
 * 회의 한 건의 발언 전부를 받아 검색어 낱말이 모두 들어 있는 발언을 고른다(로컬 색인과 같은 기준: 공백 무시, AND).
 * 상세 응답의 content_hl 강조는 실측에서 비어 있었으므로 쓰지 않는다.
 */
export async function nanetMatches(confId, query, { limit = 5 } = {}) {
  const html = await fetchText(`${NANET}/meeting/detail?${detailParams(confId, query)}`, { timeoutMs: 60000 });
  const m = /var _contentList = JSON\.parse\('([\s\S]*?)'\);/.exec(html);
  if (!m) throw new Error(`nanet 회의 ${confId}: 발언 목록이 없습니다`);
  const list = JSON.parse(m[1].replace(/\\'/g, "'"));
  const terms = parseQuery(query);
  const hits = list
    .map((x) => ({ x, text: Array.isArray(x.content) ? x.content.join('\n') : String(x.content ?? '') }))
    .filter(({ text }) => {
      const n = normalize(text);
      return terms.every((t) => n.includes(t));
    })
    .map(({ x, text }) => ({
      seq_no: x.seq_no,
      speaker: clean(x.speaker),
      speaker_id: x.speaker_id || null,
      agenda: clean(x.agenda) || null,
      snippet: snippet(text, terms),
    }));
  // 안건명은 발언마다 같은 긴 글이 반복되므로 회의 단위 목록으로 한 번만 주고 발언에는 번호만 단다
  const agendas = [];
  const matches = hits.slice(0, limit).map(({ agenda, ...h }) => {
    if (!agenda) return h;
    let i = agendas.indexOf(agenda);
    if (i < 0) i = agendas.push(agenda) - 1;
    return { ...h, agenda_no: i };
  });
  return {
    conf_id: confId,
    title: clean(list[0]?.meeting_title) || null,
    turns: list.length,
    matched: hits.length,
    agendas: agendas.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…` : a)),
    matches,
  };
}
