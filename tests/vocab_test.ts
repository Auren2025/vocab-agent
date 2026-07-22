import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(PROJECT_ROOT, "scripts/vocab.ts");

type CommandResult = {
  code: number;
  data: Record<string, unknown>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function first<T>(items: T[], message: string): T {
  const item = items[0];
  assert(item !== undefined, message);
  return item;
}

async function runVocab(
  tempDir: string,
  ...args: string[]
): Promise<CommandResult> {
  const scriptPath = resolve(tempDir, "scripts/vocab.ts");
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--allow-read=${tempDir}`,
      `--allow-write=${tempDir}`,
      scriptPath,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout).trim();

  return {
    code: result.code,
    data: JSON.parse(stdout) as Record<string, unknown>,
  };
}

async function withTempDb(test: (tempDir: string) => Promise<void>) {
  const tempDir = await Deno.makeTempDir({ prefix: "vocab-agent-test-" });
  try {
    await Deno.mkdir(resolve(tempDir, "scripts"), { recursive: true });
    await Deno.copyFile(SCRIPT_PATH, resolve(tempDir, "scripts/vocab.ts"));
    await test(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("normalizes phrase whitespace and creates a safe hint", () =>
  withTempDb(async (tempDir) => {
    const added = await runVocab(tempDir, "add", "look  up", "v. 查找");
    assertEquals(added.code, 0, "add should succeed");
    const addedWord = added.data.word as Record<string, unknown>;
    assertEquals(addedWord.word, "look up", "word should be normalized");

    const quiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "5",
      "--total",
      "1",
    );
    assertEquals(quiz.code, 0, "quiz should succeed");
    assert(
      String(quiz.data.displayBlock).includes("(l••• u•) [短语]"),
      "quiz should contain the normalized phrase hint",
    );
  }));

Deno.test("migrates legacy phrase whitespace", () =>
  withTempDb(async (tempDir) => {
    const dataDir = resolve(tempDir, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(resolve(dataDir, "vocab.db"));
    db.exec(`
      CREATE TABLE vocabulary_words (
        id TEXT PRIMARY KEY,
        word TEXT NOT NULL UNIQUE,
        meaning TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO vocabulary_words (id, word, meaning)
      VALUES ('legacy', 'look${"\t"}up', 'v. 查找');
    `);
    db.close();

    const list = await runVocab(tempDir, "list");
    assertEquals(list.code, 0, "legacy database should migrate");
    const items = list.data.items as Array<Record<string, unknown>>;
    const migrated = first(items, "list should contain the migrated phrase");
    assertEquals(
      migrated.word,
      "look up",
      "legacy phrase should be normalized",
    );
    assertEquals(
      migrated.type,
      "chunk",
      "tab-separated legacy phrase should migrate to chunk",
    );

    const duplicate = await runVocab(
      tempDir,
      "add",
      "LOOK UP",
      "v. 查阅",
    );
    assertEquals(
      duplicate.data.action,
      "exists",
      "normalized phrase should deduplicate",
    );
  }));

Deno.test("rejects a database schema newer than the application", () =>
  withTempDb(async (tempDir) => {
    const dataDir = resolve(tempDir, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(resolve(dataDir, "vocab.db"));
    db.exec("PRAGMA user_version = 99;");
    db.close();

    const list = await runVocab(tempDir, "list");
    assertEquals(list.code, 1, "newer schema should be rejected");
    assert(
      String(list.data.error).includes("newer than supported version"),
      "schema error should explain the incompatibility",
    );
    const unchanged = new DatabaseSync(resolve(dataDir, "vocab.db"));
    const { count } = unchanged.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
    ).get() as { count: number };
    unchanged.close();
    assertEquals(
      count,
      0,
      "newer database should not receive current schema tables",
    );
  }));

Deno.test("rolls back migration when normalized legacy words collide", () =>
  withTempDb(async (tempDir) => {
    const dataDir = resolve(tempDir, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    let db = new DatabaseSync(resolve(dataDir, "vocab.db"));
    db.exec(`
      CREATE TABLE vocabulary_words (
        id TEXT PRIMARY KEY,
        word TEXT NOT NULL UNIQUE,
        meaning TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO vocabulary_words (id, word, meaning)
      VALUES ('first', 'look  up', 'v. 查找');
      INSERT INTO vocabulary_words (id, word, meaning)
      VALUES ('second', 'LOOK UP', 'v. 查阅');
    `);
    db.close();

    const list = await runVocab(tempDir, "list");
    assertEquals(list.code, 1, "conflicting migration should fail");
    assert(
      String(list.data.error).includes("cannot migrate duplicate"),
      "migration should explain the conflicting entries",
    );

    db = new DatabaseSync(resolve(dataDir, "vocab.db"));
    const { user_version: schemaVersion } = db.prepare("PRAGMA user_version")
      .get() as { user_version: number };
    const columns = db.prepare("PRAGMA table_info(vocabulary_words)")
      .all() as Array<{ name: string }>;
    const words = db.prepare("SELECT word FROM vocabulary_words ORDER BY id")
      .all() as Array<{ word: string }>;
    db.close();
    assertEquals(
      schemaVersion,
      0,
      "failed migration should keep the old version",
    );
    assert(
      !columns.some((column) => column.name === "type"),
      "failed migration should roll back the added column",
    );
    assertEquals(
      words.map((word) => word.word).join(","),
      "look  up,LOOK UP",
      "failed migration should preserve the original words",
    );
  }));

Deno.test("does not create a missing dictionary database", () =>
  withTempDb(async (tempDir) => {
    const lookup = await runVocab(tempDir, "lookup", "apple");
    assertEquals(lookup.code, 1, "lookup without a dictionary should fail");
    assert(
      String(lookup.data.error).includes("dictionary database unavailable"),
      "lookup should report the missing dictionary",
    );

    try {
      await Deno.stat(resolve(tempDir, "data/dict.db"));
      throw new Error("missing dictionary should not be created");
    } catch (error) {
      assert(
        error instanceof Deno.errors.NotFound,
        "dictionary should stay missing",
      );
    }
  }));

Deno.test("refuses to delete a word referenced by a quiz session", () =>
  withTempDb(async (tempDir) => {
    await runVocab(tempDir, "add", "apple", "n. 苹果");
    const quiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );
    const answers = quiz.data.answers as Array<Record<string, unknown>>;
    const answer = first(answers, "quiz should return an answer");
    const sessionId = String(quiz.data.sessionId);

    const deleted = await runVocab(tempDir, "delete", "apple");
    assertEquals(deleted.code, 1, "referenced delete should fail");
    assert(
      String(deleted.data.error).includes("referenced by 1 quiz session"),
      "delete should explain why it failed",
    );

    const answered = await runVocab(
      tempDir,
      "answer",
      String(answer.id),
      "correct",
      "--session",
      sessionId,
      "--input",
      "apple",
    );
    assertEquals(
      answered.code,
      0,
      "preserved session should remain answerable",
    );

    const result = await runVocab(
      tempDir,
      "quiz-result",
      "--session",
      sessionId,
    );
    assertEquals(result.data.complete, true, "session should still complete");
  }));

Deno.test("reports legacy session corruption instead of getting stuck", () =>
  withTempDb(async (tempDir) => {
    await runVocab(tempDir, "add", "apple", "n. 苹果");
    await runVocab(tempDir, "add", "book", "n. 书");
    const quiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "2",
    );
    const db = new DatabaseSync(resolve(tempDir, "data/vocab.db"));
    db.prepare(
      "DELETE FROM quiz_session_words WHERE sessionId = ? AND position = 1",
    ).run(String(quiz.data.sessionId));
    db.close();

    const result = await runVocab(
      tempDir,
      "quiz-result",
      "--session",
      String(quiz.data.sessionId),
    );
    assertEquals(result.code, 1, "corrupt session should fail clearly");
    assert(
      String(result.data.error).includes("session data is inconsistent"),
      "corrupt session should return an integrity error",
    );
  }));

Deno.test("cleans expired sessions at most once per day without changing score", () =>
  withTempDb(async (tempDir) => {
    await runVocab(tempDir, "add", "apple", "n. 苹果");
    const incompleteQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );
    const completedQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );
    const completedAnswer = first(
      completedQuiz.data.answers as Array<Record<string, unknown>>,
      "completed quiz should return an answer",
    );
    await runVocab(
      tempDir,
      "answer",
      String(completedAnswer.id),
      "correct",
      "--session",
      String(completedQuiz.data.sessionId),
      "--input",
      "apple",
    );
    const recentQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );

    const dbPath = resolve(tempDir, "data/vocab.db");
    let db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE quiz_sessions SET createdAt = datetime('now', '-8 days') WHERE id = ?",
    ).run(String(incompleteQuiz.data.sessionId));
    db.prepare(
      "UPDATE quiz_sessions SET createdAt = datetime('now', '-40 days') WHERE id = ?",
    ).run(String(completedQuiz.data.sessionId));
    db.prepare(
      "UPDATE quiz_session_words SET answeredAt = datetime('now', '-31 days') WHERE sessionId = ?",
    ).run(String(completedQuiz.data.sessionId));
    db.close();

    await runVocab(tempDir, "list");
    db = new DatabaseSync(dbPath);
    const beforeDue = db.prepare("SELECT COUNT(*) AS count FROM quiz_sessions")
      .get() as { count: number };
    assertEquals(
      beforeDue.count,
      3,
      "recent cleanup marker should skip the scan",
    );
    db.prepare(
      "UPDATE app_metadata SET value = datetime('now', '-2 days') WHERE key = 'last_session_cleanup'",
    ).run();
    db.close();

    const list = await runVocab(tempDir, "list");
    db = new DatabaseSync(dbPath);
    const remaining = db.prepare("SELECT id FROM quiz_sessions ORDER BY id")
      .all() as Array<{ id: string }>;
    db.close();

    assertEquals(remaining.length, 1, "two expired sessions should be deleted");
    assertEquals(
      remaining[0]?.id,
      recentQuiz.data.sessionId,
      "recent incomplete session should be retained",
    );
    const items = list.data.items as Array<Record<string, unknown>>;
    assertEquals(
      first(items, "word should remain after cleanup").score,
      1,
      "cleanup should preserve the accumulated score",
    );
  }));

Deno.test("keeps concurrent score updates from different sessions", () =>
  withTempDb(async (tempDir) => {
    await runVocab(tempDir, "add", "apple", "n. 苹果");
    const firstQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );
    const secondQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "1",
    );
    const firstAnswer = first(
      firstQuiz.data.answers as Array<Record<string, unknown>>,
      "first quiz should return an answer",
    );
    const secondAnswer = first(
      secondQuiz.data.answers as Array<Record<string, unknown>>,
      "second quiz should return an answer",
    );

    const results = await Promise.all([
      runVocab(
        tempDir,
        "answer",
        String(firstAnswer.id),
        "correct",
        "--session",
        String(firstQuiz.data.sessionId),
        "--input",
        "apple",
      ),
      runVocab(
        tempDir,
        "answer",
        String(secondAnswer.id),
        "correct",
        "--session",
        String(secondQuiz.data.sessionId),
        "--input",
        "apple",
      ),
    ]);
    assert(
      results.every((result) => result.code === 0),
      "both answers should succeed",
    );

    const list = await runVocab(tempDir, "list");
    const items = list.data.items as Array<Record<string, unknown>>;
    assertEquals(
      first(items, "list should return the word").score,
      2,
      "both score increments should be retained",
    );
  }));

Deno.test("deduplicates concurrent case variants", () =>
  withTempDb(async (tempDir) => {
    const additions = await Promise.all([
      runVocab(tempDir, "add", "Apple", "n. 苹果"),
      runVocab(tempDir, "add", "apple", "n. 苹果"),
    ]);
    assert(
      additions.every((addition) => addition.code === 0),
      "both idempotent add commands should succeed",
    );
    const actions = additions.map((addition) => addition.data.action).sort();
    assertEquals(
      actions.join(","),
      "created,exists",
      "only one add should create a row",
    );

    const list = await runVocab(tempDir, "list");
    assertEquals(
      list.data.count,
      1,
      "case variants should share one vocabulary row",
    );
  }));

Deno.test("rejects malformed and unexpected CLI arguments", () =>
  withTempDb(async (tempDir) => {
    const missingInput = await runVocab(
      tempDir,
      "answer",
      "word-id",
      "correct",
      "--session",
      "session-id",
      "--input",
      "--unexpected",
    );
    assertEquals(missingInput.code, 1, "flag-looking input should be rejected");
    assert(
      String(missingInput.data.error).includes("missing value for --input"),
      "missing input should produce a precise error",
    );

    const unknownFlag = await runVocab(tempDir, "quiz", "--unknown", "5");
    assertEquals(unknownFlag.code, 1, "unknown quiz flag should be rejected");
    const extraLookupWord = await runVocab(tempDir, "lookup", "look", "up");
    assertEquals(extraLookupWord.code, 1, "unquoted phrase should be rejected");
  }));

Deno.test("serializes concurrent claims for the same quiz session", () =>
  withTempDb(async (tempDir) => {
    for (let index = 0; index < 3; index++) {
      await runVocab(tempDir, "add", `word-${index}`, `n. 单词${index}`);
    }

    const firstQuiz = await runVocab(
      tempDir,
      "quiz",
      "--limit",
      "1",
      "--total",
      "3",
    );
    const firstAnswer = first(
      firstQuiz.data.answers as Array<Record<string, unknown>>,
      "quiz should return an answer",
    );
    await runVocab(
      tempDir,
      "answer",
      String(firstAnswer.id),
      "correct",
      "--session",
      String(firstQuiz.data.sessionId),
      "--input",
      String(firstAnswer.word),
    );

    const claims = await Promise.all([
      runVocab(
        tempDir,
        "quiz",
        "--limit",
        "1",
        "--session",
        String(firstQuiz.data.sessionId),
      ),
      runVocab(
        tempDir,
        "quiz",
        "--limit",
        "1",
        "--session",
        String(firstQuiz.data.sessionId),
      ),
    ]);
    const successfulClaims = claims.filter((claim) => claim.code === 0);
    const rejectedClaims = claims.filter((claim) => claim.code === 1);
    assertEquals(successfulClaims.length, 1, "only one claim should succeed");
    assertEquals(rejectedClaims.length, 1, "the duplicate claim should fail");
    const rejectedClaim = first(
      rejectedClaims,
      "one duplicate claim should be rejected",
    );
    assert(
      String(rejectedClaim.data.error).includes("unanswered words"),
      "duplicate claim should report the pending answer",
    );
  }));
