#!/usr/bin/env node
// 의사중계 AI 자막 녹화기. 중계가 끝날 때까지 자막 WebSocket 의 확정 프레임을 날짜별 JSONL 로 쌓는다.
//   node src/caption-recorder.js --all          지금·앞으로 중계되는 자막 방송 전부
//   node src/caption-recorder.js 63 25          xcode 지정
// 1분마다 중계 목록을 다시 보고, 새 방송은 붙고 끝난 방송은 닫는다. 대상이 모두 끝나고 30분(지정 모드는 5분) 지나면 종료.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser } from './browser.js';
import { broadcastKey, CAPTION_DIR, captionDir, kstDate, liveTargets } from './captions.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const xcodes = args.filter((a) => /^\d+$/.test(a));
if (!all && !xcodes.length) {
  console.error('usage: caption-recorder.js --all | <xcode>...');
  process.exit(2);
}

const POLL_MS = 60_000;
const IDLE_EXIT_MS = (all ? 30 : 5) * 60_000;
const MAX_RUN_MS = 16 * 60 * 60_000;
captionDir();
const lockFile = join(CAPTION_DIR, `recorder-${all ? 'all' : xcodes.join('-')}.json`);
const log = (msg) => appendFileSync(join(CAPTION_DIR, 'recorder.log'), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (existsSync(lockFile)) {
  const prev = JSON.parse(readFileSync(lockFile, 'utf8'));
  if (alive(prev.pid)) {
    console.log(`이미 녹화 중 (pid ${prev.pid})`);
    process.exit(0);
  }
}

const active = new Map(); // key -> { target, ws, file, meta, stopped }
const startedAt = Date.now();
let lastLive = Date.now();

function writeLock() {
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, mode: all ? 'all' : 'xcode', xcodes, started: new Date(startedAt).toISOString(), heartbeat: new Date().toISOString(), broadcasts: [...active.keys()] }),
  );
}

function writeMeta(rec) {
  rec.meta.updated = new Date().toISOString();
  writeFileSync(rec.file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(rec.meta));
}

function connect(rec) {
  if (rec.stopped) return;
  const ws = new WebSocket(rec.target.ws, 'echo-protocol');
  rec.ws = ws;
  ws.onopen = () => log(`open ${rec.key} ${rec.target.ws}`);
  ws.onerror = () => {};
  ws.onclose = (e) => {
    log(`close ${rec.key} ${e.code}`);
    if (!rec.stopped) setTimeout(() => connect(rec), 5000); // 플레이어와 같은 5초 재접속
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.segment == null || !m.final) return; // 인식 중 프레임은 버리고 확정만
    const pieces = Array.isArray(m.transcripts) && m.transcripts.length ? m.transcripts : [[-1, m.transcript ?? '']];
    appendFileSync(
      rec.file,
      `${JSON.stringify({ seg: m.segment, off: m['segment-offset'], dur: m['segment-duration'], ts: m['send-timestamp'], scd: Boolean(m.scd), pieces })}\n`,
    );
    rec.frames++;
  };
}

function stop(rec, why) {
  rec.stopped = true;
  try {
    rec.ws?.close();
  } catch {}
  writeMeta(rec);
  active.delete(rec.key);
  log(`stop ${rec.key} (${why}), frames ${rec.frames}`);
}

async function poll() {
  let targets;
  try {
    targets = await liveTargets({ xcodes: all ? undefined : xcodes });
  } catch (e) {
    log(`poll error ${e.message}`);
    return;
  }
  const seen = new Set();
  for (const t of targets) {
    const key = broadcastKey(t);
    seen.add(key);
    const rec = active.get(key);
    if (rec) {
      rec.meta.agendas = t.agendas;
      rec.meta.status = t.status;
      writeMeta(rec);
      continue;
    }
    // 같은 자막 서버를 이미 듣고 있으면(같은 회의실) 두 번 열지 않는다
    if ([...active.values()].some((r) => r.target.ws === t.ws)) continue;
    const date = kstDate();
    const file = join(captionDir(date), `${key}.jsonl`);
    const prev = existsSync(file.replace(/\.jsonl$/, '.meta.json')) ? JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) : null;
    const meta = { xcode: t.xcode, xcgcd: t.xcgcd, name: t.name, subject: t.subject, status: t.status, agendas: t.agendas, ws: t.ws, date, started: prev?.started ?? new Date().toISOString() };
    const nrec = { key, target: t, file, meta, frames: 0, stopped: false };
    active.set(key, nrec);
    writeMeta(nrec);
    log(`start ${key} ${t.name} ${t.subject ?? ''}`);
    connect(nrec);
  }
  for (const rec of [...active.values()]) if (!seen.has(rec.key)) stop(rec, '중계 종료');
  if (active.size) lastLive = Date.now();
  writeLock();
}

async function shutdown(code = 0) {
  for (const rec of [...active.values()]) stop(rec, '녹화기 종료');
  try {
    unlinkSync(lockFile);
  } catch {}
  await closeBrowser().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log(`recorder start ${all ? '--all' : xcodes.join(',')}`);
writeLock();
await poll();
const timer = setInterval(async () => {
  await poll();
  if (Date.now() - lastLive > IDLE_EXIT_MS || Date.now() - startedAt > MAX_RUN_MS) {
    clearInterval(timer);
    log('idle exit');
    await shutdown(0);
  }
}, POLL_MS);
