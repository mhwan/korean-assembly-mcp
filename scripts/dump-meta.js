// 사용할 OpenAPI 들의 명세(서비스 ID·요청 변수·출력 필드)를 사이트에서 받아 data/openapi-specs.json 에 저장한다
import { mkdirSync, writeFileSync } from 'node:fs';
import { closeBrowser } from '../src/browser.js';
import { openApiCatalog, openApiMeta } from '../src/openapi.js';

const WANTED = [
  '국회의원 인적사항',
  '국회의원 정보 통합 API',
  '위원회 위원 명단',
  '위원회 현황 정보',
  '국회의원 상임위 활동',
  '국회의원 발의법률안',
  '의안정보 통합 API',
  '의안 상세정보',
  '의안 제안자정보',
  '의안 접수목록',
  '법률안 제안이유 및 주요내용',
  '법률안 심사 및 처리(의안검색)',
  '의안 위원회심사 회의정보 조회',
  '의안 심사정보(예ㆍ결산 제외)',
  '소위 심사정보(법률안)',
  '국회의원 본회의 표결정보',
  '의안별 표결현황',
  '위원회 회의록',
  '회의록별 상세정보',
  '회의별 안건목록',
  '영상회의록 목록',
  '국회의원 영상회의록(발언영상)',
  '국회일정 통합 API',
  '위원회별 일정',
  '위원회별 전체회의 일정',
  '위원회별 소위원회 일정',
  '위원회별 공청회 일정',
  '본회의 일정',
  '의원실 행사 정보',
  '국회의원 세미나 일정',
  '국회의원 정책 세미나 개최 현황',
  '국회의원 기자회견',
  '국회발간물 통합 API',
  '국회입법조사처 제공 자료 통합 API',
  '국회예산정책처 제공 자료 통합 API',
  '국회미래연구원 제공 자료 통합 API',
  '국회도서관 제공 자료 통합 API',
];

const catalog = await openApiCatalog();
const specs = [];
for (const name of WANTED) {
  const item = catalog.find((c) => c.infaNm === name);
  const seq = item?.openSrv?.split(',').find((s) => s.startsWith('A-'))?.slice(2);
  if (!item || !seq) {
    console.error('없음:', name);
    continue;
  }
  const meta = await openApiMeta(item.infaId, seq);
  specs.push({
    name,
    infaId: item.infaId,
    service: meta.apiRes,
    urls: (meta.urls ?? []).map((u) => ({ name: u.uriNm, service: u.apiRes })),
    request: (meta.variables ?? []).map((v) => ({ id: v.colId, name: v.colNm, need: v.reqNeed, example: v.smpColExp })),
    output: (meta.cols ?? meta.columns ?? meta.outputs ?? []).map((c) => ({ id: c.colId, name: c.colNm })),
    rawKeys: Object.keys(meta),
  });
  console.error('ok:', name, meta.apiRes);
}
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/openapi-specs.json', import.meta.url), JSON.stringify(specs, null, 1));
await closeBrowser();
