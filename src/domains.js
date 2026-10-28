// 법안·표결·일정·생중계
import { fetchJson } from './browser.js';
import { callOpenApi, callOpenApiAll, callOpenApiDateRange } from './openapi.js';

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row[k] != null && row[k] !== '').map((k) => [k, row[k]]));

/**
 * 법률안 검색. 제안일 최신순으로 돌려준다.
 * 기본은 국회의원 발의법률안(nzmimeepazxkubdpn). 위원장안(대안)·정부안은 거기 없으므로
 * proposer_kind 를 주거나 proposer 가 "…위원장"이면 법률안 심사 및 처리(TVBPMBILL11)로 찾는다.
 */
export async function searchBills({ name, proposer, proposer_kind, committee, result, from, to, limit = 30, age = 22 }) {
  if (!proposer_kind && /위원장$/.test(proposer ?? '')) proposer_kind = '위원장';
  // 두 API 모두 제안일 최신순이고 날짜 검색 변수가 없어서, 기간은 쪽을 찾아가며 거른다
  const fetchRows = (service, params) =>
    from || to
      ? callOpenApiDateRange(service, params, { field: 'PROPOSE_DT', from, to, need: limit })
      : callOpenApiAll(service, params, { max: Math.max(limit, 300) });
  const { total, rows } = proposer_kind
    ? await fetchRows('TVBPMBILL11', {
        AGE: age, BILL_NAME: name, PROPOSER: proposer, PROPOSER_KIND: proposer_kind, CURR_COMMITTEE: committee, PROC_RESULT_CD: result,
      }).then(({ total, rows }) => ({
        total,
        rows: rows.map((r) => ({ ...r, COMMITTEE: r.CURR_COMMITTEE, PROC_RESULT: r.PROC_RESULT_CD, DETAIL_LINK: r.LINK_URL })),
      }))
    : await fetchRows('nzmimeepazxkubdpn', { AGE: age, BILL_NAME: name, PROPOSER: proposer, COMMITTEE: committee, PROC_RESULT: result });
  const bills = rows
    .sort((a, b) => (b.PROPOSE_DT ?? '').localeCompare(a.PROPOSE_DT ?? '') || Number(b.BILL_NO) - Number(a.BILL_NO))
    .slice(0, limit)
    .map((r) =>
      pick(r, [
        'BILL_ID', 'BILL_NO', 'BILL_NAME', 'PROPOSER', 'RST_PROPOSER', 'COMMITTEE', 'PROPOSE_DT',
        'CMT_PROC_RESULT_CD', 'LAW_PROC_RESULT_CD', 'PROC_RESULT', 'PROC_DT', 'DETAIL_LINK',
      ]),
    );
  return { total, returned: bills.length, bills };
}

/** 의안 상세: 진행 단계(ALLBILLV2) + 제안이유(BPMBILLSUMMARY) + 제안자(BILLINFOPPSR) + 위원회 심사 회의(BILLJUDGECONF) */
export async function billDetail({ bill_id, bill_no, age = 22 }) {
  const base = (await callOpenApi('ALLBILLV2', { ERACO: `제${age}대`, BILL_ID: bill_id, BILL_NO: bill_no })).rows[0];
  if (!base) throw new Error(`의안을 찾지 못했습니다: ${bill_id ?? bill_no}`);
  const id = base.BILL_ID;
  const [summary, proposers, reviews] = await Promise.all([
    callOpenApi('BPMBILLSUMMARY', { BILL_NO: base.BILL_NO }).catch(() => ({ rows: [] })),
    callOpenApiAll('BILLINFOPPSR', { BILL_ID: id }).catch(() => ({ rows: [] })),
    callOpenApiAll('BILLJUDGECONF', { BILL_ID: id }).catch(() => ({ rows: [] })),
  ]);
  const isAlt = base.PPSR_KND === '위원장';
  const [originals, alternative] = await Promise.all([
    isAlt ? alternativeOriginals(id, age).catch(() => null) : null,
    /대안반영/.test(base.JRCMIT_PROC_RSLT ?? '') ? findAlternative(base, age).catch(() => undefined) : null,
  ]);
  // 제안자·심사 회의 행마다 의안 필드가 통째로 반복되므로 필요한 칸만 남긴다
  return {
    bill: Object.fromEntries(Object.entries(base).filter(([, v]) => v != null && v !== '')),
    summary: summary.rows[0]?.SUMMARY ?? null,
    proposer_count: proposers.rows.length,
    proposers: proposers.rows
      .map((r) => ({ name: r.PPSR_NM, party: r.PPSR_POLY_NM, ...(r.REP_DIV ? { rep: r.REP_DIV } : {}), ...(r.PPSR_ROLE && r.PPSR_ROLE !== '발의자' ? { role: r.PPSR_ROLE } : {}) }))
      .sort((a, b) => Number(!a.rep) - Number(!b.rep)),
    committee_reviews: reviews.rows.map((r) => ({ conf: r.JRCMIT_CONF_NM, date: r.JRCMIT_CONF_DT, result: r.JRCMIT_CONF_RSLT })),
    ...(originals ? { original_bills: originals } : {}),
    ...(alternative !== null
      ? {
          alternative:
            alternative ??
            `대안을 자동으로 찾지 못했습니다(같은 위원회 위원장안 가운데 처리일이 같고 원안 목록에 이 의안이 든 것이 없음). 대안이 없다는 뜻은 아닙니다 — 법률명이 다른 대안에 묶였을 수 있으니 assembly_bills { proposer_kind: '위원장', committee: '${base.JRCMIT_NM ?? ''}' } 로 찾아보세요.`,
        }
      : {}),
  };
}

const billRef = (r) => ({ bill_id: r.BILL_ID, bill_no: r.BILL_NO, name: r.BILL_NAME, proposer: r.PROPOSER, proposed: r.PROPOSE_DT, result: r.PROC_RESULT_CD });

/** 위원장안(대안)에 반영된 원안들(TVBPMBILL11 BILL_ID_REF) */
async function alternativeOriginals(altId, age) {
  const { rows } = await callOpenApiAll('TVBPMBILL11', { AGE: age, BILL_ID_REF: altId }, { max: 500 });
  return rows.map(billRef);
}

/**
 * 대안반영폐기된 원안이 들어간 대안. 같은 위원회 위원장안 가운데 위원회 처리일이 같은 것을 고르고,
 * 그 대안의 원안 목록(BILL_ID_REF)에 이 의안이 있는지로 확인한다. 못 찾으면 undefined.
 * 법사위 위원장안은 CMT_PROC_DT 가 비어 있고 제안일(PROPOSE_DT)이 원안의 위원회 처리일과 같다(2221413 등).
 */
async function findAlternative(base, age) {
  if (!base.JRCMIT_NM || !base.JRCMIT_PROC_DT) return undefined;
  const { rows } = await callOpenApiAll('TVBPMBILL11', { AGE: age, PROPOSER_KIND: '위원장', CURR_COMMITTEE: base.JRCMIT_NM }, { max: 2000 });
  const day = base.JRCMIT_PROC_DT;
  const law = String(base.BILL_NAME ?? '').replace(/\s*(일부개정|전부개정|폐지|제정)?법률안.*$/, '');
  const cands = rows
    .filter((r) => r.CMT_PROC_DT === day || (!r.CMT_PROC_DT && r.PROPOSE_DT === day))
    .sort((a, b) => Number(!a.BILL_NAME?.startsWith(law)) - Number(!b.BILL_NAME?.startsWith(law))); // 같은 법률 대안부터 확인
  for (const c of cands) {
    const originals = await alternativeOriginals(c.BILL_ID, age);
    if (originals.some((o) => o.bill_id === base.BILL_ID)) return { ...billRef(c), originals: originals.length };
  }
  return undefined;
}

/** 본회의 표결: 의안별 집계(ncocpgfiaoituanbr) + 의원별 찬반(nojepdqqaweusdfbi) */
export async function billVotes({ bill_id, member, party, age = 22 }) {
  const [tally, votes] = await Promise.all([
    callOpenApi('ncocpgfiaoituanbr', { AGE: age, BILL_ID: bill_id }),
    callOpenApiAll('nojepdqqaweusdfbi', { AGE: age, BILL_ID: bill_id, HG_NM: member, POLY_NM: party }),
  ]);
  const byResult = {};
  const byParty = {};
  for (const v of votes.rows) {
    byResult[v.RESULT_VOTE_MOD] = (byResult[v.RESULT_VOTE_MOD] ?? 0) + 1;
    const p = (byParty[v.POLY_NM] ??= {});
    p[v.RESULT_VOTE_MOD] = (p[v.RESULT_VOTE_MOD] ?? 0) + 1;
  }
  return {
    tally: tally.rows[0]
      ? pick(tally.rows[0], ['BILL_NAME', 'PROC_DT', 'PROC_RESULT_CD', 'MEMBER_TCNT', 'VOTE_TCNT', 'YES_TCNT', 'NO_TCNT', 'BLANK_TCNT', 'LINK_URL'])
      : null,
    by_result: byResult,
    by_party: byParty,
    members: votes.rows.map((v) => ({ name: v.HG_NM, party: v.POLY_NM, district: v.ORIG_NM, vote: v.RESULT_VOTE_MOD })),
    ...(!tally.rows[0] && !votes.rows.length ? { note: `본회의 표결 기록이 없습니다: ${bill_id}(본회의에 오르지 않았거나 의안 ID 가 틀림)` } : {}),
  };
}

/** 국회일정 통합(ALLSCHEDULE). date 는 YYYY-MM-DD (YYYY-MM, YYYY 도 검색어로 받는다). */
export async function schedule({ date, kind, committee }) {
  // 연 단위는 5000건을 넘으므로 끝까지 받는다. 일부만 돌려주면 앞 달이 조용히 빠진다
  const { total, rows } = await callOpenApiAll('ALLSCHEDULE', { SCH_DT: date, SCH_KIND: kind }, { max: 50000 });
  if (rows.length < total) throw new Error(`일정이 ${total}건이라 다 받지 못했습니다. YYYY-MM 으로 나눠 조회하세요.`);
  const items = rows
    .filter((r) => !committee || r.CMIT_NM?.includes(committee))
    .sort((a, b) => `${a.SCH_DT} ${a.SCH_TM ?? ''}`.localeCompare(`${b.SCH_DT} ${b.SCH_TM ?? ''}`))
    .map((r) => pick(r, ['SCH_DT', 'SCH_TM', 'SCH_KIND', 'CONF_DIV', 'CMIT_NM', 'SCH_CN', 'EV_INST_NM', 'EV_PLC']));
  // 연 단위 전체는 수십만 자라 대화에 넣을 수 없다. 자르지 않고 좁히라고 알린다
  const chars = JSON.stringify(items).length;
  if (chars > 150000) {
    throw new Error(`일정 ${items.length}건(약 ${Math.round(chars / 1000)}천 자)이라 너무 큽니다. YYYY-MM 으로 나누거나 kind·committee 로 좁히세요.`);
  }
  return items;
}

/** live_list 항목이 중계 중인가. xstat 은 중계 없음이 "0", 특별위처럼 채널만 있는 항목은 빈 문자열이다. */
export const isLive = (x) => Boolean(x.xstat) && x.xstat !== '0';

/** 의사중계 현재 중계 목록(assembly.webcast.go.kr live_list.asp) */
export async function liveList({ onlyLive = false } = {}) {
  const json = await fetchJson('https://assembly.webcast.go.kr/main/service/live_list.asp');
  return (json.xlist ?? [])
    .map((x) => ({
      name: x.xname,
      xcode: x.xcode,
      xcgcd: x.xcgcd,
      subject: x.xsubj,
      live: isLive(x),
      status: x.xdesc,
      ai_captions: x.xsami === '1', // assembly_live_captions_record 로 녹화 가능
      committee_code: x.xbill,
      link: x.xlink,
    }))
    .filter((x) => !onlyLive || x.live);
}
