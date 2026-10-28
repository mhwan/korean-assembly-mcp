// 통합 검색: 로컬 색인(가져온 적 있는 회의록·자막·보고서 본문)과 국회도서관 회의록 전문 검색(nanet, 전체 회의록)을 합친다.
import { nanetMatches, nanetSearch } from './nanet.js';
import { searchIndex } from './search-index.js';

/**
 * remote: off(로컬만) | auto(로컬이 0건일 때만 nanet) | on(둘 다) | only(nanet 만)
 * remote_detail: nanet 상위 회의 몇 건의 일치 발언을 열어 볼지(회의당 수 초)
 */
export async function assemblySearch({ query, sources, from, to, committee, speaker, order, limit = 20, offset = 0, remote = 'auto', remote_page = 1, remote_detail = 3 }) {
  const out = { query };
  if (remote !== 'only') out.local = searchIndex({ query, sources, from, to, committee, speaker, order, limit, offset });
  const wantRemote = remote === 'on' || remote === 'only' || (remote === 'auto' && out.local.total_hits === 0);
  if (!wantRemote) return out;

  try {
    // nanet 은 공백으로 나뉜 낱말을 형태소로 다시 쪼개므로 따옴표는 떼고 보낸다
    const q = String(query).replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    const page = await nanetSearch({ query: q, committee: committee ? committee.replace(/(위|위원회)?$/, '위원회') : undefined, page: remote_page });
    const meetings = page.meetings.filter((m) => (!from || (m.date ?? '') >= from) && (!to || (m.date ?? '') <= to));
    for (const m of meetings.slice(0, remote_detail)) {
      try {
        const d = await nanetMatches(m.conf_id, q, { limit: 5 });
        Object.assign(m, { matched_in_detail: d.matched, agendas: d.agendas, matches: d.matches });
      } catch (e) {
        m.detail_error = e.message;
      }
    }
    out.remote = {
      source: '국회도서관 국회회의록 빅데이터(dataset.nanet.go.kr), 관련도순',
      page: page.page,
      has_more: page.has_more,
      counts_note:
        'matched_speeches 는 nanet 형태소 검색이 센 발언 수(낱말이 쪼개져 걸린 것 포함), matched_in_detail 은 그 회의 발언 가운데 검색어 낱말이 띄어쓰기 무시하고 모두 들어 있는 발언 수다. 그래서 둘이 다를 수 있다. matches 의 agenda_no 는 agendas 번호다.',
      ...(from || to ? { note: '날짜 조건은 이 쪽(10건) 안에서만 거른 결과다. nanet 목록은 날짜 범위를 받지 않는다.' } : {}),
      ...(speaker ? { speaker_note: 'speaker 조건은 nanet 에 적용하지 않았다.' } : {}),
      how_to_open: 'conf_id 는 assembly_committee_meetings 결과의 conf_id 와 같다. 같은 날짜로 조회해 confer_num 을 얻어 assembly_meeting_speeches 로 원문을 연다.',
      meetings,
    };
  } catch (e) {
    out.remote = { error: e.message };
  }
  return out;
}
