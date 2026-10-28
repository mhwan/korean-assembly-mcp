// 로컬 색인: 도구가 가져온 회의록 발언·자막·PDF 본문을 SQLite(FTS5 trigram)에 저장해 날짜를 넘어 전문 검색한다.
// 원문(text)은 그대로 두고, 공백을 모두 지운 정규화본(norm)에 색인을 건다. PDF 추출 텍스트의 "박정    현"이나
// "전세 사기"·"전세사기" 같은 띄어쓰기 차이를 같은 말로 찾기 위해서다. trigram 은 3글자 이상만 색인을 타므로
// 2글자 이하 검색어는 LIKE 전체 훑기로 찾는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const INDEX_DB = process.env.ASSEMBLY_INDEX_DB ?? join(homedir(), '.cache', 'assembly-mcp', 'index.db');
export const INDEX_SOURCES = ['minutes', 'caption', 'bill_report', 'audit_report'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  title TEXT,
  date TEXT,
  committee TEXT,
  url TEXT,
  meta TEXT,
  hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE (source, doc_key)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT,
  mem_id TEXT,
  section TEXT,
  pos INTEGER,
  text TEXT NOT NULL,
  norm TEXT NOT NULL,
  UNIQUE (doc_id, seq)
);
CREATE INDEX IF NOT EXISTS docs_date ON docs(date);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(norm, content='chunks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, norm) VALUES (new.id, new.norm);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, norm) VALUES ('delete', old.id, old.norm);
END;
`;

let db = null;
function open() {
  if (db) return db;
  mkdirSync(dirname(INDEX_DB), { recursive: true });
  db = new DatabaseSync(INDEX_DB);
  db.exec(SCHEMA);
  return db;
}

export function closeIndex() {
  db?.close();
  db = null;
}

export const normalize = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');

/**
 * 문서 한 건을 통째로 저장한다. 같은 (source, key) 가 있으면 내용이 바뀐 경우에만 갈아 끼운다.
 * chunks: [{speaker, mem_id, section, pos, text}]
 */
export function saveDoc({ source, key, title, date, committee, url, meta, chunks }) {
  if (!INDEX_SOURCES.includes(source)) throw new Error(`알 수 없는 색인 출처: ${source}`);
  const rows = chunks.filter((c) => c.text?.trim());
  const hash = createHash('sha1')
    .update(JSON.stringify([title, date, committee, rows.map((c) => [c.speaker, c.mem_id, c.section, c.pos, c.text])]))
    .digest('hex');
  const d = open();
  const old = d.prepare('SELECT id, hash FROM docs WHERE source = ? AND doc_key = ?').get(source, String(key));
  if (old?.hash === hash) return { status: 'unchanged', chunks: rows.length };

  const chars = rows.reduce((n, c) => n + c.text.length, 0);
  const now = new Date().toISOString();
  d.exec('BEGIN IMMEDIATE');
  try {
    let docId = old?.id;
    if (docId) {
      d.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
      d.prepare(
        'UPDATE docs SET title=?, date=?, committee=?, url=?, meta=?, hash=?, chunk_count=?, char_count=?, indexed_at=? WHERE id=?',
      ).run(title ?? null, date ?? null, committee ?? null, url ?? null, meta ? JSON.stringify(meta) : null, hash, rows.length, chars, now, docId);
    } else {
      docId = Number(
        d.prepare(
          'INSERT INTO docs (source, doc_key, title, date, committee, url, meta, hash, chunk_count, char_count, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).run(source, String(key), title ?? null, date ?? null, committee ?? null, url ?? null, meta ? JSON.stringify(meta) : null, hash, rows.length, chars, now)
          .lastInsertRowid,
      );
    }
    const ins = d.prepare('INSERT INTO chunks (doc_id, seq, speaker, mem_id, section, pos, text, norm) VALUES (?,?,?,?,?,?,?,?)');
    rows.forEach((c, i) =>
      ins.run(docId, i, c.speaker ?? null, c.mem_id ?? null, c.section ?? null, c.pos ?? null, c.text, normalize(c.text)),
    );
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { status: old ? 'updated' : 'added', chunks: rows.length };
}

/** 도구 응답을 막지 않도록 저장 실패는 메시지로만 돌려준다. ASSEMBLY_INDEX=off 면 저장하지 않는다. */
export function autoSave(doc) {
  if (process.env.ASSEMBLY_INDEX === 'off') return 'off';
  try {
    const r = saveDoc(doc);
    return `${r.status}(${r.chunks})`;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

export function hasDoc(source, key) {
  return Boolean(open().prepare('SELECT 1 FROM docs WHERE source = ? AND doc_key = ?').get(source, String(key)));
}

/** 긴 본문(PDF)을 문단 경계로 size 자 안팎씩 자른다. pos 는 원문에서의 시작 위치 */
export function chunkText(text, size = 1500) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      const line = text.lastIndexOf('\n', end);
      if (para > start + size / 2) end = para;
      else if (line > start + size / 2) end = line;
    }
    const piece = text.slice(start, end);
    if (piece.trim()) out.push({ pos: start, text: piece });
    start = end;
  }
  return out;
}

/** 검색어 → 낱말 목록. "따옴표 묶음"은 한 낱말. 각 낱말은 공백을 지운 정규화본 */
export function parseQuery(query) {
  const terms = [];
  for (const m of String(query ?? '').matchAll(/"([^"]+)"|(\S+)/g)) {
    // 닫히지 않은 따옴표("전세 사기)는 낱말에 붙지 않게 지운다
    const t = normalize((m[1] ?? m[2]).replaceAll('"', ''));
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 정규화본의 낱말을 원문에서 찾는 정규식(글자 사이 공백 허용)
const looseRegex = (term, flags = '') => new RegExp([...term].map(escapeRegex).join('\\s*'), flags);

/** 원문에서 첫 일치 주변 ±width 자. 일치 부분은 【】로 감싼다 */
export function snippet(text, terms, width = 90) {
  const spans = [];
  for (const t of terms) {
    for (const m of text.matchAll(looseRegex(t, 'g'))) spans.push([m.index, m.index + m[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (!spans.length) return text.slice(0, width * 2).replace(/\s+/g, ' ');
  const from = Math.max(0, spans[0][0] - width);
  const to = Math.min(text.length, spans[0][1] + width);
  let out = '';
  let at = from;
  for (const [s, e] of spans) {
    if (s < at || e > to) continue;
    out += `${text.slice(at, s)}【${text.slice(s, e)}】`;
    at = e;
  }
  out += text.slice(at, to);
  return `${from > 0 ? '…' : ''}${out.replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/**
 * 색인 검색. 낱말은 모두 들어 있어야 한다(AND).
 * - sources: 출처 거르기, from/to: 문서 날짜(YYYY-MM-DD), committee·speaker: 부분일치
 * - order: relevance(bm25, 기본) 또는 date(최신순)
 */
export function searchIndex({ query, sources, from, to, committee, speaker, order = 'relevance', limit = 20, offset = 0 }) {
  const terms = parseQuery(query);
  if (!terms.length) throw new Error('검색어가 비었습니다');
  const ftsTerms = terms.filter((t) => [...t].length >= 3);
  const likeTerms = terms.filter((t) => [...t].length < 3);

  const where = [];
  const params = [];
  if (ftsTerms.length) {
    where.push('chunks_fts MATCH ?');
    params.push(ftsTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '));
  }
  for (const t of likeTerms) {
    where.push("c.norm LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(t)}%`);
  }
  if (sources?.length) {
    where.push(`d.source IN (${sources.map(() => '?').join(',')})`);
    params.push(...sources);
  }
  if (from) {
    where.push('d.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('d.date <= ?');
    params.push(to);
  }
  if (committee) {
    where.push("d.committee LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(committee)}%`);
  }
  if (speaker) {
    where.push("c.speaker LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(speaker)}%`);
  }
  const fromClause = ftsTerms.length
    ? 'FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN docs d ON d.id = c.doc_id'
    : 'FROM chunks c JOIN docs d ON d.id = c.doc_id';
  const whereClause = `WHERE ${where.join(' AND ')}`;
  const orderClause =
    order === 'date' || !ftsTerms.length
      ? 'ORDER BY d.date DESC, d.id DESC, c.seq'
      : 'ORDER BY bm25(chunks_fts), d.date DESC';

  const d = open();
  const totals = d.prepare(`SELECT COUNT(*) AS hits, COUNT(DISTINCT c.doc_id) AS docs ${fromClause} ${whereClause}`).get(...params);
  const rows = d
    .prepare(
      `SELECT c.seq, c.speaker, c.mem_id, c.section, c.pos, c.text, d.source, d.doc_key, d.title, d.date, d.committee, d.url, d.meta
       ${fromClause} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return {
    query: { terms, indexed_terms: ftsTerms, scanned_terms: likeTerms },
    total_hits: totals.hits,
    total_docs: totals.docs,
    offset,
    returned: rows.length,
    ...(offset + rows.length < totals.hits ? { next_offset: offset + rows.length } : {}),
    hits: rows.map((r) => ({
      source: r.source,
      key: r.doc_key,
      title: r.title,
      date: r.date,
      committee: r.committee,
      speaker: r.speaker,
      section: r.section,
      ...(r.pos != null ? { offset: r.pos } : {}),
      seq: r.seq,
      snippet: snippet(r.text, terms),
      url: r.url,
      ...(r.meta ? { meta: JSON.parse(r.meta) } : {}),
    })),
  };
}

/** 색인 현황: 출처별 문서·조각·글자 수, 날짜 범위, DB 크기 */
export function indexStats() {
  const d = open();
  const bySource = d
    .prepare(
      `SELECT source, COUNT(*) AS docs, SUM(chunk_count) AS chunks, SUM(char_count) AS chars, MIN(date) AS first_date, MAX(date) AS last_date, MAX(indexed_at) AS last_indexed
       FROM docs GROUP BY source ORDER BY source`,
    )
    .all();
  const files = [INDEX_DB, `${INDEX_DB}-wal`].filter(existsSync);
  return {
    db: INDEX_DB,
    bytes: files.reduce((n, f) => n + statSync(f).size, 0),
    sources: bySource.map((r) => ({ ...r })),
  };
}

/** 최근 색인된 문서 목록 */
export function listDocs({ source, limit = 30 } = {}) {
  const sql = `SELECT source, doc_key AS key, title, date, committee, chunk_count AS chunks, char_count AS chars, indexed_at
    FROM docs ${source ? 'WHERE source = ?' : ''} ORDER BY indexed_at DESC LIMIT ?`;
  return open().prepare(sql).all(...(source ? [source, limit] : [limit])).map((r) => ({ ...r }));
}
