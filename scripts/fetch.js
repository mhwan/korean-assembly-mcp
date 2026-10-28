// URL 하나를 실브라우저로 받아 앞부분을 출력한다 (응답 구조 확인용)
// 사용: node scripts/fetch.js <URL> [--chars=N]
import { closeBrowser, fetchText } from '../src/browser.js';

const [url, ...rest] = process.argv.slice(2);
const chars = Number(rest.find((a) => a.startsWith('--chars='))?.slice(8) ?? 4000);
try {
  const text = await fetchText(url);
  console.log(`length=${text.length}`);
  console.log(text.slice(0, chars));
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  await closeBrowser();
}
