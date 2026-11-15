import { DatabaseSync } from "node:sqlite";
import { ChangeJournalTestDb } from "./changeJournalTestDb";

/**
 * The in-memory Zotero database the agent runtime tests run against.
 *
 * `Zotero.DB.queryAsync` is hand-written SQL pattern matching over the
 * agent-runs, run-events and transcript statements, with everything else
 * delegated to {@link ChangeJournalTestDb}.  Every runtime test that needs a
 * conversation to survive across turns shares this one fixture, so the SQL
 * contract is asserted in one place instead of being re-guessed per file.
 */

export type MockDbRow = Record<string, unknown>;

export type InstalledMockDb = (() => void) & {
  runs: Map<string, MockDbRow>;
  events: MockDbRow[];
  transcripts: MockDbRow[];
  journalDb: ChangeJournalTestDb;
  setTranscriptWriteFailure: (enabled: boolean) => void;
  transcriptWriteAttempts: () => number;
};

export function installMockDb(): InstalledMockDb {
  const runs = new Map<string, MockDbRow>();
  const events: MockDbRow[] = [];
  const transcripts: MockDbRow[] = [];
  const prefs = new Map<string, unknown>();
  const journalDb = new ChangeJournalTestDb();
  let failTranscriptWrites = false;
  let transcriptWriteAttempts = 0;
  let runRowId = 0;
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (
          sql.includes("llm_for_zotero_agent_transcript") &&
          (sql.includes("DELETE FROM") || sql.includes("INSERT INTO"))
        ) {
          transcriptWriteAttempts += 1;
          if (failTranscriptWrites) {
            throw new Error("Injected transcript write failure");
          }
        }
        if (sql.includes("INSERT OR REPLACE INTO llm_for_zotero_agent_runs")) {
          runs.set(String(params[0]), {
            rowid: (runRowId += 1),
            runId: params[0],
            conversationKey: params[1],
            mode: params[2],
            modelName: params[3],
            status: params[4],
            createdAt: params[5],
            completedAt: params[6],
            finalText: params[7],
          });
          return [];
        }
        if (
          sql.includes("UPDATE llm_for_zotero_agent_runs") &&
          sql.includes("WHERE status = 'running'")
        ) {
          for (const run of runs.values()) {
            if (run.status !== "running") continue;
            run.status = params[0];
            run.completedAt = params[1];
            run.finalText = params[2];
          }
          return [];
        }
        if (sql.includes("UPDATE llm_for_zotero_agent_runs")) {
          const run = runs.get(String(params[3]));
          if (run) {
            run.status = params[0];
            run.completedAt = params[1];
            run.finalText = params[2];
          }
          return [];
        }
        if (sql.includes("INSERT INTO llm_for_zotero_agent_run_events")) {
          events.push({
            runId: params[0],
            seq: params[1],
            eventType: params[2],
            payloadJson: params[3],
            createdAt: params[4],
          });
          return [];
        }
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_run_events")
        ) {
          // listAgentRunEvents narrows to specific event types in SQL when
          // the caller only needs a few; the extra parameters are those types.
          const eventTypes = params.slice(1).map(String);
          return events
            .filter(
              (entry) =>
                entry.runId === params[0] &&
                (!eventTypes.length ||
                  eventTypes.includes(String(entry.eventType))),
            )
            .sort((a, b) => Number(a.seq) - Number(b.seq));
        }
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_runs") &&
          sql.includes("WHERE conversation_key = ?")
        ) {
          const conversationRuns = [...runs.values()].filter(
            (run) => Number(run.conversationKey) === Number(params[0]),
          );
          // listAgentRunsForConversation asks for every run oldest first, or
          // for the newest `limit` runs; getLatestAgentRunForConversation asks
          // for the newest one only (a literal LIMIT 1, so no second
          // parameter). All of them break a created_at tie on rowid, as the
          // real SQL does.
          if (sql.includes("ORDER BY created_at ASC")) {
            return conversationRuns.sort(
              (left, right) =>
                Number(left.createdAt) - Number(right.createdAt) ||
                Number(left.rowid) - Number(right.rowid),
            );
          }
          return conversationRuns
            .sort(
              (left, right) =>
                Number(right.createdAt) - Number(left.createdAt) ||
                Number(right.rowid) - Number(left.rowid),
            )
            .slice(0, params.length > 1 ? Number(params[1]) : 1);
        }
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_runs")
        ) {
          const run = runs.get(String(params[0]));
          return run ? [run] : [];
        }
        if (sql.includes("DELETE FROM llm_for_zotero_agent_transcript")) {
          for (let index = transcripts.length - 1; index >= 0; index -= 1) {
            if (
              Number(transcripts[index].conversationKey) ===
                Number(params[0]) &&
              transcripts[index].compatibilityKey === params[1]
            ) {
              transcripts.splice(index, 1);
            }
          }
          return [];
        }
        if (sql.includes("INSERT INTO llm_for_zotero_agent_transcript")) {
          transcripts.push({
            conversationKey: params[0],
            compatibilityKey: params[1],
            sequence: params[2],
            messageJson: params[3],
            compactedAt: params[4],
            createdAt: params[5],
          });
          return [];
        }
        if (
          sql.includes("FROM llm_for_zotero_agent_transcript") &&
          sql.includes("ORDER BY created_at DESC")
        ) {
          return transcripts
            .filter(
              (row) =>
                Number(row.conversationKey) === Number(params[0]) &&
                typeof row.compatibilityKey === "string",
            )
            .sort(
              (left, right) =>
                Number(right.createdAt) - Number(left.createdAt) ||
                transcripts.indexOf(right) - transcripts.indexOf(left),
            )
            .slice(0, 1)
            .map((row) => ({ compatibilityKey: row.compatibilityKey }));
        }
        if (sql.includes("FROM llm_for_zotero_agent_transcript")) {
          return transcripts
            .filter(
              (row) =>
                Number(row.conversationKey) === Number(params[0]) &&
                row.compatibilityKey === params[1],
            )
            .sort(
              (left, right) => Number(left.sequence) - Number(right.sequence),
            );
        }
        return journalDb.queryAsync(sql, params);
      },
    },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => {
        prefs.set(key, value);
      },
    },
  };
  const restore = () => {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  };
  return Object.assign(restore, {
    runs,
    events,
    transcripts,
    journalDb,
    setTranscriptWriteFailure: (enabled: boolean) => {
      failTranscriptWrites = enabled;
    },
    transcriptWriteAttempts: () => transcriptWriteAttempts,
  });
}

/**
 * Tables whose statements are too much SQL to fake by hand: aggregates,
 * joins, `INSERT OR IGNORE`, `PRAGMA table_info`. They run on real sqlite.
 */
const SQLITE_BACKED_TABLES = [
  "llm_for_zotero_plan_document",
  "llm_for_zotero_agent_batch_",
];

/**
 * The agent-run mock database is hand-written SQL pattern matching. The
 * document and durable-batch stores need real SQL, so their statements are
 * routed to an in-memory sqlite database while every other statement stays on
 * the mock.
 */
export function installAgentStoreSqlite(): () => void {
  const zotero = globalThis as typeof globalThis & { Zotero: typeof Zotero };
  const base = zotero.Zotero.DB;
  const db = new DatabaseSync(":memory:");
  zotero.Zotero.DB = {
    ...base,
    queryAsync: async (sql: string, params: unknown[] = []) => {
      if (!SQLITE_BACKED_TABLES.some((table) => sql.includes(table)))
        return base.queryAsync(sql, params);
      const statement = db.prepare(sql);
      const values = params.map((value) =>
        value === undefined ? null : value,
      ) as never[];
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return statement.all(...values);
      statement.run(...values);
      return [];
    },
  } as unknown as typeof Zotero.DB;
  return () => {
    zotero.Zotero.DB = base;
    db.close();
  };
}
