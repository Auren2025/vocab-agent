import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(PROJECT_ROOT, "data/vocab.db");
const DICT_PATH = resolve(PROJECT_ROOT, "data/dict.db");
const SESSION_CLEANUP_KEY = "last_session_cleanup";
const CURRENT_SCHEMA_VERSION = 3;

const VOCAB_TYPES = ["word", "chunk"] as const;
type VocabType = typeof VOCAB_TYPES[number];

type VocabWord = {
  id: string;
  word: string;
  type: VocabType;
  meaning: string;
  score: number;
  createdAt: string;
};

type QuizSession = {
  id: string;
  totalCount: number;
  nextPosition: number;
};

type QuizStats = {
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
};

function inferVocabType(word: string): VocabType {
  return /\s/u.test(word) ? "chunk" : "word";
}

function normalizeWord(word: string): string {
  return word.trim().split(/\s+/u).join(" ");
}

function migrateDb(db: DatabaseSync) {
  const { user_version: initialSchemaVersion } = db.prepare(
    "PRAGMA user_version",
  )
    .get() as { user_version: number };

  if (initialSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${initialSchemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  if (initialSchemaVersion === CURRENT_SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const { user_version: schemaVersion } = db.prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `database schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (schemaVersion === CURRENT_SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }

    const columns = db
      .prepare("PRAGMA table_info(vocabulary_words)")
      .all() as Array<{ name: string }>;
    const hasType = columns.some((column) => column.name === "type");
    if (!hasType) {
      db.exec(`
        ALTER TABLE vocabulary_words
        ADD COLUMN type TEXT NOT NULL DEFAULT 'word'
        CHECK (type IN ('word', 'chunk'));
      `);
    }

    const words = db.prepare("SELECT id, word FROM vocabulary_words")
      .all() as Array<{ id: string; word: string }>;
    const normalizedWords = words.map((word) => ({
      ...word,
      normalizedWord: normalizeWord(word.word),
    }));
    const seenWords = new Map<string, string>();

    for (const word of normalizedWords) {
      if (!word.normalizedWord) {
        throw new Error(`cannot migrate empty vocabulary entry: ${word.id}`);
      }
      const normalizedKey = word.normalizedWord.toLowerCase();
      if (seenWords.has(normalizedKey)) {
        const duplicate = seenWords.get(normalizedKey);
        throw new Error(
          `cannot migrate duplicate vocabulary entries: "${duplicate}" and "${word.word}"`,
        );
      }
      seenWords.set(normalizedKey, word.word);
    }

    const updateWord = db.prepare(
      "UPDATE vocabulary_words SET word = ?, type = ? WHERE id = ?",
    );
    for (const word of normalizedWords) {
      updateWord.run(
        word.normalizedWord,
        inferVocabType(word.normalizedWord),
        word.id,
      );
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_word_nocase
      ON vocabulary_words(word COLLATE NOCASE);
      PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sessionCleanupIsDue(db: DatabaseSync): boolean {
  const metadata = db.prepare(
    `
      SELECT value BETWEEN datetime('now', '-1 day') AND datetime('now', '+5 minutes')
        AS isRecent
      FROM app_metadata
      WHERE key = ?
    `,
  ).get(SESSION_CLEANUP_KEY) as { isRecent: number } | undefined;

  return metadata?.isRecent !== 1;
}

function maybeCleanupSessions(db: DatabaseSync) {
  if (!sessionCleanupIsDue(db)) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (sessionCleanupIsDue(db)) {
      const expiredSessions = db.prepare(
        `
          SELECT s.id
          FROM quiz_sessions AS s
          WHERE (
            s.createdAt < datetime('now', '-7 days')
            AND (
              SELECT COUNT(q.result)
              FROM quiz_session_words AS q
              WHERE q.sessionId = s.id
            ) < s.totalCount
          ) OR (
            COALESCE((
              SELECT MAX(q.answeredAt)
              FROM quiz_session_words AS q
              WHERE q.sessionId = s.id
            ), s.createdAt) < datetime('now', '-30 days')
            AND (
              SELECT COUNT(q.result)
              FROM quiz_session_words AS q
              WHERE q.sessionId = s.id
            ) >= s.totalCount
          )
        `,
      ).all() as Array<{ id: string }>;
      const deleteWords = db.prepare(
        "DELETE FROM quiz_session_words WHERE sessionId = ?",
      );
      const deleteSession = db.prepare(
        "DELETE FROM quiz_sessions WHERE id = ?",
      );

      for (const session of expiredSessions) {
        deleteWords.run(session.id);
        deleteSession.run(session.id);
      }

      db.prepare(
        `
          INSERT INTO app_metadata (key, value)
          VALUES (?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      ).run(SESSION_CLEANUP_KEY);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const { user_version: schemaVersion } = db.prepare("PRAGMA user_version")
    .get() as { user_version: number };
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS vocabulary_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'word' CHECK (type IN ('word', 'chunk')),
      meaning TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vocabulary_score_created
    ON vocabulary_words(score, createdAt);

    CREATE TABLE IF NOT EXISTS quiz_sessions (
      id TEXT PRIMARY KEY,
      totalCount INTEGER NOT NULL,
      nextPosition INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quiz_session_words (
      sessionId TEXT NOT NULL,
      position INTEGER NOT NULL,
      wordId TEXT NOT NULL,
      result TEXT CHECK (result IN ('correct', 'wrong')),
      userAnswer TEXT,
      answeredAt TEXT,
      PRIMARY KEY (sessionId, position),
      UNIQUE (sessionId, wordId),
      FOREIGN KEY (sessionId) REFERENCES quiz_sessions(id),
      FOREIGN KEY (wordId) REFERENCES vocabulary_words(id)
    );

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  migrateDb(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vocabulary_type_score_created
    ON vocabulary_words(type, score, createdAt);
  `);
  maybeCleanupSessions(db);

  return db;
}

function output(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function createId() {
  return crypto.randomUUID();
}

function addWord(word: string | undefined, meaning: string | undefined) {
  if (!word || !meaning) {
    throw new Error('Usage: deno task add <word> "<meaning>"');
  }

  const displayWord = normalizeWord(word);
  const normalizedWord = displayWord.toLowerCase();
  const normalizedMeaning = meaning.trim();

  if (!normalizedWord) {
    throw new Error("word cannot be empty.");
  }

  if (!normalizedMeaning) {
    throw new Error("meaning cannot be empty.");
  }

  const db = openDb();
  let response: { ok: true; action: "exists" | "created"; word: VocabWord };

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `
          SELECT id, word, type, meaning, score, createdAt
          FROM vocabulary_words
          WHERE word = ? COLLATE NOCASE
        `,
      )
      .get(displayWord) as VocabWord | undefined;

    if (existing) {
      response = { ok: true, action: "exists", word: existing };
    } else {
      const id = createId();
      const type = inferVocabType(displayWord);
      db.prepare(
        `
          INSERT INTO vocabulary_words (id, word, type, meaning, score)
          VALUES (?, ?, ?, ?, 0)
        `,
      ).run(id, displayWord, type, normalizedMeaning);
      const created = db
        .prepare(
          `
            SELECT id, word, type, meaning, score, createdAt
            FROM vocabulary_words
            WHERE id = ?
          `,
        )
        .get(id) as VocabWord;
      response = { ok: true, action: "created", word: created };
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  output(response);
}

function makeHint(word: string): string {
  return normalizeWord(word).split(" ").map((part) => {
    const [first, ...rest] = [...part];
    return first + "•".repeat(rest.length);
  })
    .join(" ");
}

function selectQuizWords(db: DatabaseSync, limit: number) {
  const learning = db
    .prepare(
      `
    SELECT id, word, type, meaning, score, createdAt
    FROM vocabulary_words
    WHERE score BETWEEN 0 AND 5
    ORDER BY score ASC, createdAt ASC
    LIMIT 15
  `,
    )
    .all() as VocabWord[];

  const mastering = db
    .prepare(
      `
    SELECT id, word, type, meaning, score, createdAt
    FROM vocabulary_words
    WHERE score BETWEEN 6 AND 10
    ORDER BY score ASC, createdAt ASC
    LIMIT 8
  `,
    )
    .all() as VocabWord[];

  const skilled = db
    .prepare(
      `
    SELECT id, word, type, meaning, score, createdAt
    FROM vocabulary_words
    WHERE score BETWEEN 11 AND 20
    ORDER BY score ASC, createdAt ASC
    LIMIT 5
  `,
    )
    .all() as VocabWord[];

  const expert = db
    .prepare(
      `
    SELECT id, word, type, meaning, score, createdAt
    FROM vocabulary_words
    WHERE score >= 21
    ORDER BY score ASC, createdAt ASC
    LIMIT 2
  `,
    )
    .all() as VocabWord[];

  const preferred = [...learning, ...mastering, ...skilled, ...expert];
  const selectedIds = new Set(preferred.map((word) => word.id));

  if (preferred.length < limit) {
    const remaining = db
      .prepare(
        `
        SELECT id, word, type, meaning, score, createdAt
        FROM vocabulary_words
        ORDER BY score ASC, createdAt ASC
      `,
      )
      .all() as VocabWord[];

    for (const word of remaining) {
      if (!selectedIds.has(word.id)) {
        preferred.push(word);
        selectedIds.add(word.id);
      }

      if (preferred.length >= limit) {
        break;
      }
    }
  }

  return preferred.slice(0, limit);
}

function getQuizStats(db: DatabaseSync, sessionId: string): QuizStats {
  return db.prepare(
    `
    SELECT
      COUNT(result) AS answeredCount,
      COALESCE(SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END), 0)
        AS correctCount,
      COALESCE(SUM(CASE WHEN result = 'wrong' THEN 1 ELSE 0 END), 0)
        AS wrongCount
    FROM quiz_session_words
    WHERE sessionId = ?
  `,
  ).get(sessionId) as QuizStats;
}

function assertSessionIntegrity(db: DatabaseSync, session: QuizSession) {
  const integrity = db.prepare(
    `
      SELECT
        COUNT(q.wordId) AS rowCount,
        COUNT(v.id) AS wordCount,
        COALESCE(MIN(q.position), 0) AS firstPosition,
        COALESCE(MAX(q.position), -1) AS lastPosition
      FROM quiz_session_words AS q
      LEFT JOIN vocabulary_words AS v ON v.id = q.wordId
      WHERE q.sessionId = ?
    `,
  ).get(session.id) as {
    rowCount: number;
    wordCount: number;
    firstPosition: number;
    lastPosition: number;
  };
  const positionsAreContiguous = integrity.wordCount === 0 ||
    (integrity.firstPosition === 0 &&
      integrity.lastPosition === integrity.wordCount - 1);

  if (
    integrity.rowCount !== session.totalCount ||
    integrity.wordCount !== session.totalCount || !positionsAreContiguous ||
    session.nextPosition < 0 || session.nextPosition > session.totalCount
  ) {
    throw new Error(
      `quiz session data is inconsistent: ${session.id}; start a new session`,
    );
  }
}

function formatQuiz(
  items: VocabWord[],
  session?: QuizSession,
  stats?: QuizStats,
) {
  const formattedItems = items.map((item) => {
    const meaningOneLine = item.meaning.replace(/\r?\n/g, "；");
    const hint = makeHint(item.word);
    const isPhrase = item.type === "chunk";
    const displayLine = isPhrase
      ? `${meaningOneLine} (${hint}) [短语]`
      : `${meaningOneLine} (${hint})`;
    return { ...item, hint, isPhrase, displayLine };
  });

  const displayBlock = formattedItems
    .map((item, i) => `${i + 1}. ${item.displayLine}`)
    .join("\n");

  const answers = formattedItems.map((item) => ({
    id: item.id,
    word: item.word,
  }));

  return {
    ok: true,
    count: items.length,
    displayBlock,
    answers,
    ...(session
      ? {
        sessionId: session.id,
        totalCount: session.totalCount,
        shownCount: session.nextPosition,
        remainingCount: session.totalCount - session.nextPosition,
        answeredCount: stats?.answeredCount ?? 0,
        allShown: session.nextPosition >= session.totalCount,
        complete: (stats?.answeredCount ?? 0) >= session.totalCount,
      }
      : {}),
  };
}

function startQuizSession(db: DatabaseSync, total: number) {
  const session: QuizSession = {
    id: createId(),
    totalCount: 0,
    nextPosition: 0,
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const words = selectQuizWords(db, total);
    session.totalCount = words.length;
    db.prepare(
      `
      INSERT INTO quiz_sessions (id, totalCount, nextPosition)
      VALUES (?, ?, 0)
    `,
    ).run(session.id, session.totalCount);

    const insertWord = db.prepare(
      `
      INSERT INTO quiz_session_words (sessionId, position, wordId)
      VALUES (?, ?, ?)
    `,
    );
    words.forEach((word, position) => {
      insertWord.run(session.id, position, word.id);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return session;
}

function getQuiz(limit = 5, total?: number, sessionId?: string) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  if (limit > 5) {
    throw new Error("limit cannot be greater than 5.");
  }

  if (total !== undefined && (!Number.isInteger(total) || total < 1)) {
    throw new Error("total must be a positive integer.");
  }

  if (total !== undefined && sessionId) {
    throw new Error("Use --total to start or --session to continue, not both.");
  }

  const db = openDb();

  if (total === undefined && !sessionId) {
    throw new Error(
      "Use --total to start a quiz session, or --session to continue an existing session.",
    );
  }

  const newSession = sessionId ? undefined : startQuizSession(db, total!);
  const targetSessionId = sessionId ?? newSession!.id;
  let response: ReturnType<typeof formatQuiz>;

  db.exec("BEGIN IMMEDIATE");
  try {
    const session = db.prepare(
      `
        SELECT id, totalCount, nextPosition
        FROM quiz_sessions
        WHERE id = ?
      `,
    ).get(targetSessionId) as QuizSession | undefined;

    if (!session) {
      throw new Error(`quiz session not found: ${targetSessionId}`);
    }
    assertSessionIntegrity(db, session);

    if (session.nextPosition > 0) {
      const { pendingCount } = db.prepare(
        `
          SELECT COUNT(*) AS pendingCount
          FROM quiz_session_words
          WHERE sessionId = ? AND position < ? AND result IS NULL
        `,
      ).get(session.id, session.nextPosition) as { pendingCount: number };

      if (pendingCount > 0) {
        throw new Error(
          `Finish the ${pendingCount} unanswered words before the next round.`,
        );
      }
    }

    const items = db.prepare(
      `
        SELECT v.id, v.word, v.type, v.meaning, v.score, v.createdAt
        FROM quiz_session_words AS q
        JOIN vocabulary_words AS v ON v.id = q.wordId
        WHERE q.sessionId = ? AND q.position >= ?
        ORDER BY q.position ASC
        LIMIT ?
      `,
    ).all(session.id, session.nextPosition, limit) as VocabWord[];

    session.nextPosition += items.length;
    response = formatQuiz(items, session, getQuizStats(db, session.id));
    db.prepare(
      `
        UPDATE quiz_sessions
        SET nextPosition = ?
        WHERE id = ?
      `,
    ).run(session.nextPosition, session.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  output(response);
}

function answerWord(
  id: string | undefined,
  result: string | undefined,
  sessionId?: string,
  userAnswer?: string,
) {
  if (!id || !result) {
    throw new Error(
      'Usage: deno task answer <id> correct|wrong --session <sessionId> --input "<答案>"',
    );
  }

  if (result !== "correct" && result !== "wrong") {
    throw new Error("result must be correct or wrong.");
  }

  const db = openDb();

  if (sessionId) {
    if (userAnswer === undefined) {
      throw new Error("--input is required for a quiz session answer.");
    }

    let response: unknown;
    db.exec("BEGIN IMMEDIATE");
    try {
      const session = db.prepare(
        `
          SELECT id, totalCount, nextPosition
          FROM quiz_sessions
          WHERE id = ?
        `,
      ).get(sessionId) as QuizSession | undefined;

      if (!session) {
        throw new Error(`quiz session not found: ${sessionId}`);
      }
      assertSessionIntegrity(db, session);

      const sessionWord = db.prepare(
        `
          SELECT
            q.position,
            q.result AS savedResult,
            q.userAnswer AS savedUserAnswer,
            v.id,
            v.word,
            v.type,
            v.meaning,
            v.score,
            v.createdAt
          FROM quiz_session_words AS q
          JOIN vocabulary_words AS v ON v.id = q.wordId
          WHERE q.sessionId = ? AND q.wordId = ?
        `,
      ).get(sessionId, id) as
        | (VocabWord & {
          position: number;
          savedResult: string | null;
          savedUserAnswer: string | null;
        })
        | undefined;

      if (!sessionWord) {
        throw new Error(`word is not in quiz session: ${id}`);
      }
      if (sessionWord.position >= session.nextPosition) {
        throw new Error("This word has not been shown yet.");
      }

      if (sessionWord.savedResult) {
        response = {
          ok: true,
          action: "already_answered",
          id,
          word: sessionWord.word,
          result: sessionWord.savedResult,
          userAnswer: sessionWord.savedUserAnswer,
          ...getQuizStats(db, sessionId),
        };
      } else {
        const oldScore = sessionWord.score;
        const newScore = result === "correct"
          ? oldScore + 1
          : Math.max(0, oldScore - 2);
        const saved = db.prepare(
          `
            UPDATE quiz_session_words
            SET result = ?, userAnswer = ?, answeredAt = CURRENT_TIMESTAMP
            WHERE sessionId = ? AND wordId = ? AND result IS NULL
          `,
        ).run(result, userAnswer, sessionId, id);

        if (saved.changes !== 1) {
          throw new Error("This answer was already saved.");
        }

        db.prepare(
          `
            UPDATE vocabulary_words
            SET score = ?
            WHERE id = ?
          `,
        ).run(newScore, id);

        response = {
          ok: true,
          action: "answered",
          id,
          word: sessionWord.word,
          meaning: sessionWord.meaning,
          result,
          userAnswer,
          oldScore,
          newScore,
          ...getQuizStats(db, sessionId),
        };
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    output(response);
    return;
  }

  throw new Error(
    "Answering without a session is no longer supported. Use --session <sessionId>.",
  );
}

function getQuizResult(sessionId: string | undefined) {
  if (!sessionId) {
    throw new Error("Usage: deno task quiz-result --session <sessionId>");
  }

  const db = openDb();
  const session = db.prepare(
    `
    SELECT id, totalCount, nextPosition
    FROM quiz_sessions
    WHERE id = ?
  `,
  ).get(sessionId) as QuizSession | undefined;

  if (!session) {
    throw new Error(`quiz session not found: ${sessionId}`);
  }
  assertSessionIntegrity(db, session);

  const stats = getQuizStats(db, sessionId);
  const wrongAnswers = db.prepare(
    `
    SELECT
      q.position,
      v.word AS correctAnswer,
      q.userAnswer,
      v.meaning
    FROM quiz_session_words AS q
    JOIN vocabulary_words AS v ON v.id = q.wordId
    WHERE q.sessionId = ? AND q.result = 'wrong'
    ORDER BY q.position ASC
  `,
  ).all(sessionId) as Array<{
    position: number;
    correctAnswer: string;
    userAnswer: string;
    meaning: string;
  }>;

  const complete = stats.answeredCount >= session.totalCount;
  const accuracy = session.totalCount === 0
    ? 0
    : Number((stats.correctCount / session.totalCount * 100).toFixed(2));

  output({
    ok: true,
    sessionId,
    totalCount: session.totalCount,
    ...stats,
    accuracy,
    complete,
    wrongAnswers,
  });
}

function openDict() {
  try {
    const db = new DatabaseSync(DICT_PATH, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `dictionary database unavailable at ${DICT_PATH}: ${message}`,
    );
  }
}

type DictEntry = {
  word: string;
  translation: string;
  pos: string;
};

function lookupWord(word: string | undefined) {
  if (!word) {
    throw new Error("Usage: deno task lookup <word>");
  }

  const db = openDict();
  const entry = db
    .prepare(
      `
      SELECT word, translation, pos
      FROM dictionary
      WHERE LOWER(word) = LOWER(?)
      LIMIT 1
    `,
    )
    .get(normalizeWord(word)) as DictEntry | undefined;

  if (!entry || !entry.translation) {
    output({ ok: false, error: "word not found in dictionary" });
    return;
  }

  output({
    ok: true,
    word: entry.word,
    translation: entry.translation,
    pos: entry.pos,
  });
}

function updateWord(word: string | undefined, meaning: string | undefined) {
  if (!word || !meaning) {
    throw new Error('Usage: deno task update <word> "<meaning>"');
  }

  const displayWord = normalizeWord(word);
  const normalizedMeaning = meaning.trim();

  if (!normalizedMeaning) {
    throw new Error("meaning cannot be empty.");
  }

  const db = openDb();

  const existing = db
    .prepare(
      `
      SELECT id, word, type, meaning, score, createdAt
      FROM vocabulary_words
      WHERE word = ? COLLATE NOCASE
    `,
    )
    .get(displayWord) as VocabWord | undefined;

  if (!existing) {
    throw new Error(`word not found: ${displayWord}`);
  }

  db.prepare(
    `
    UPDATE vocabulary_words
    SET meaning = ?
    WHERE id = ?
  `,
  ).run(normalizedMeaning, existing.id);

  const updated = db
    .prepare(
      `
      SELECT id, word, type, meaning, score, createdAt
      FROM vocabulary_words
      WHERE id = ?
    `,
    )
    .get(existing.id) as VocabWord;

  output({
    ok: true,
    action: "updated",
    word: updated,
  });
}

function deleteWord(word: string | undefined) {
  if (!word) {
    throw new Error("Usage: deno task delete <word>");
  }

  const displayWord = normalizeWord(word);
  const db = openDb();
  let deletedWord: VocabWord;

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `
          SELECT id, word, type, meaning, score, createdAt
          FROM vocabulary_words
          WHERE word = ? COLLATE NOCASE
        `,
      )
      .get(displayWord) as VocabWord | undefined;

    if (!existing) {
      throw new Error(`word not found: ${displayWord}`);
    }

    const { referenceCount } = db.prepare(
      `
        SELECT COUNT(*) AS referenceCount
        FROM quiz_session_words
        WHERE wordId = ?
      `,
    ).get(existing.id) as { referenceCount: number };

    if (referenceCount > 0) {
      throw new Error(
        `cannot delete ${displayWord}: referenced by ${referenceCount} quiz session(s)`,
      );
    }

    db.prepare(
      `
      DELETE FROM vocabulary_words
      WHERE id = ?
    `,
    ).run(existing.id);

    deletedWord = existing;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  output({
    ok: true,
    action: "deleted",
    word: deletedWord,
  });
}

function listWords() {
  const db = openDb();

  const { total, wordCount, chunkCount } = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN type = 'word' THEN 1 ELSE 0 END), 0) AS wordCount,
        COALESCE(SUM(CASE WHEN type = 'chunk' THEN 1 ELSE 0 END), 0) AS chunkCount
      FROM vocabulary_words
    `,
    )
    .get() as { total: number; wordCount: number; chunkCount: number };

  const words = db
    .prepare(
      `
    SELECT id, word, type, meaning, score, createdAt
    FROM vocabulary_words
    ORDER BY score ASC, createdAt ASC
  `,
    )
    .all() as VocabWord[];

  output({
    ok: true,
    summary: `一共${total}个, 其中单词${wordCount}个, 短语${chunkCount}个`,
    count: total,
    typeCounts: {
      word: wordCount,
      chunk: chunkCount,
    },
    items: words,
  });
}

function parseFlags(args: string[], allowedFlags: string[]) {
  const allowed = new Set(allowedFlags);
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.has(flag)) {
      throw new Error(`unknown or unexpected argument: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate argument: ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, value);
  }

  return values;
}

function requireArgumentCount(
  command: string,
  args: string[],
  expected: number,
) {
  if (args.length !== expected) {
    throw new Error(
      `${command} expects ${expected} argument(s), received ${args.length}`,
    );
  }
}

function main() {
  const [command, ...args] = Deno.args;

  try {
    if (command === "add") {
      requireArgumentCount("add", args, 2);
      addWord(args[0], args[1]);
      return;
    }

    if (command === "quiz") {
      const flags = parseFlags(args, ["--limit", "--total", "--session"]);
      const limit = flags.has("--limit") ? Number(flags.get("--limit")) : 5;
      const total = flags.has("--total")
        ? Number(flags.get("--total"))
        : undefined;
      const sessionId = flags.get("--session");
      getQuiz(limit, total, sessionId);
      return;
    }

    if (command === "answer") {
      const flags = parseFlags(args.slice(2), ["--session", "--input"]);
      const sessionId = flags.get("--session");
      const userAnswer = flags.get("--input");
      answerWord(args[0], args[1], sessionId, userAnswer);
      return;
    }

    if (command === "quiz-result") {
      const flags = parseFlags(args, ["--session"]);
      const sessionId = flags.get("--session");
      getQuizResult(sessionId);
      return;
    }

    if (command === "update") {
      requireArgumentCount("update", args, 2);
      updateWord(args[0], args[1]);
      return;
    }

    if (command === "delete") {
      requireArgumentCount("delete", args, 1);
      deleteWord(args[0]);
      return;
    }

    if (command === "list") {
      requireArgumentCount("list", args, 0);
      listWords();
      return;
    }

    if (command === "lookup") {
      requireArgumentCount("lookup", args, 1);
      lookupWord(args[0]);
      return;
    }

    output({
      ok: false,
      error: "Unknown command.",
      commands: [
        'add <word> "<meaning>"',
        'update <word> "<meaning>"',
        "quiz --limit 5 --total <count>",
        "quiz --limit 5 --session <sessionId>",
        'answer <id> correct|wrong --session <sessionId> --input "<answer>"',
        "quiz-result --session <sessionId>",
        "list",
        "lookup <word>",
        "delete <word>",
      ],
    });
    Deno.exitCode = 1;
  } catch (error) {
    output({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });

    Deno.exit(1);
  }
}

main();
