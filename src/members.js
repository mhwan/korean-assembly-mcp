// 국회의원 인적사항(nwvrqwxyaytdsfvhu) 전체를 하루 단위로 캐시하고, 이름·지역구로 찾는다
import { callOpenApiAll } from './openapi.js';

const TTL_MS = 24 * 60 * 60 * 1000;
let cache = null; // { at, rows }

export async function allMembers() {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const { rows } = await callOpenApiAll('nwvrqwxyaytdsfvhu', {}, { pSize: 300 });
    cache = { at: Date.now(), rows };
  }
  return cache.rows;
}

export function memberSummary(m) {
  return {
    name: m.HG_NM,
    party: m.POLY_NM,
    district: m.ORIG_NM,
    committees: m.CMITS,
    elected: m.REELE_GBN_NM,
    units: m.UNITS,
    code: m.MONA_CD,
    email: m.E_MAIL,
    homepage: m.HOMEPAGE,
    office: m.ASSEM_ADDR,
    tel: m.TEL_NO,
  };
}

const norm = (s) => (s ?? '').replace(/\s+/g, '');

/** 이름(+지역구)으로 의원 한 명을 찾는다. 동명이인은 지역구로 가른다. */
export async function findMember(name, district) {
  const same = (await allMembers()).filter((m) => m.HG_NM === name);
  if (same.length <= 1 || !district) return same[0];
  return same.find((m) => norm(m.ORIG_NM) === norm(district)) ?? same[0];
}

export async function searchMembers({ name, party, committee, district } = {}) {
  return (await allMembers())
    .filter((m) => !name || m.HG_NM?.includes(name))
    .filter((m) => !party || m.POLY_NM?.includes(party))
    .filter((m) => !committee || m.CMITS?.includes(committee))
    .filter((m) => !district || m.ORIG_NM?.includes(district))
    .map(memberSummary);
}
