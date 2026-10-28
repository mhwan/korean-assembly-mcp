// OpenAPI 한 서비스를 실브라우저로 호출해 건수와 앞쪽 행을 출력한다
// 사용: node scripts/sample.js <서비스ID> [KEY=VALUE ...] [--size=N]
import { closeBrowser } from '../src/browser.js';
import { callOpenApi } from '../src/openapi.js';

const [service, ...rest] = process.argv.slice(2);
const size = Number(rest.find((a) => a.startsWith('--size='))?.slice(7) ?? 3);
const params = Object.fromEntries(rest.filter((a) => !a.startsWith('--')).map((a) => a.split(/=(.*)/s).slice(0, 2)));
try {
  const { total, rows } = await callOpenApi(service, params, { pSize: size });
  console.log(JSON.stringify({ total, rows }, null, 1).slice(0, 6000));
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  await closeBrowser();
}
