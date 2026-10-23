import type { DB } from '../db/sqlite';
import { nowIso } from '../db/sqlite';
import type { Memory, MemoryCategory } from '../schemas';

interface MemoryRow {
  id: number;
  content: string;
  category: MemoryCategory;
  source: 'user' | 'inferred';
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

const STOPWORDS = new Set(
  `a an and are as at be but by can do does for from have how i in is it its me my of on or our please so that the
   their them there this to was we what when where which who why will with you your about into than then just also
   create add make task tasks remind remember tell show list get set need want would should could`.split(/\s+/),
);

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    source: row.source,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Builds a safe FTS5 MATCH expression from free text: quoted prefix terms joined by OR. */
export function toFtsQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 12);
  if (unique.length === 0) return null;
  return unique.map((w) => `"${w}"*`).join(' OR ');
}

export class MemoryRepository {
  constructor(private readonly db: DB) {}

  create(input: { content: string; category?: MemoryCategory; source: 'user' | 'inferred'; metadata?: Record<string, unknown> }): Memory {
    const now = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO memories (content, category, source, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.content, input.category ?? 'other', input.source, input.metadata ? JSON.stringify(input.metadata) : null, now, now);
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  }

  findExact(content: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE lower(content) = lower(?)').get(content) as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  }

  /** Keyword search ranked by FTS5 bm25; without keywords returns the most recently updated memories. */
  search(opts: { query?: string; category?: MemoryCategory; limit?: number } = {}): Memory[] {
    const limit = opts.limit ?? 10;
    const fts = opts.query ? toFtsQuery(opts.query) : null;
    if (opts.query && !fts) return [];
    if (fts) {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH @fts ${opts.category ? 'AND m.category = @category' : ''}
           ORDER BY bm25(memories_fts) LIMIT @limit`,
        )
        .all({ fts, category: opts.category, limit }) as MemoryRow[];
      return rows.map(toMemory);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${opts.category ? 'WHERE category = @category' : ''}
         ORDER BY updated_at DESC, id DESC LIMIT @limit`,
      )
      .all({ category: opts.category, limit }) as MemoryRow[];
    return rows.map(toMemory);
  }

  update(id: number, patch: { content?: string; category?: MemoryCategory }): Memory | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE memories SET content = COALESCE(@content, content), category = COALESCE(@category, category), updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, content: patch.content ?? null, category: patch.category ?? null, now: nowIso() });
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes === 1;
  }

  clear(): number {
    return this.db.prepare('DELETE FROM memories').run().changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  }
}

const SENSITIVE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(pass(word|wd|code)?|pwd|pin|otp|cvv|secret|api[-_ ]?key|access[-_ ]?token|private[-_ ]?key)\b\s*(is|=|:)/i, reason: 'looks like a password, PIN or secret' },
  { re: /\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/, reason: 'looks like an API key or token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'contains a private key' },
  { re: /\b(?:\d[ -]?){13,19}\b/, reason: 'looks like a payment card or account number' },
  { re: /\b\d{4}\s?\d{4}\s?\d{4}\b/, reason: 'looks like a national ID number' },
];

/** Returns a reason if the text appears to contain a credential or sensitive identifier. */
export function detectSensitive(text: string): string | null {
  for (const { re, reason } of SENSITIVE_PATTERNS) if (re.test(text)) return reason;
  return null;
}
