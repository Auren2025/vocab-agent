import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "./data/vocab.db";

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
  return word.includes(" ") ? "chunk" : "word";
}

function migrateDb(db: DatabaseSync) {
  const columns = db
    .prepare("PRAGMA table_info(vocabulary_words)")
    .all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "type")) {
    db.exec(`
      ALTER TABLE vocabulary_words
      ADD COLUMN type TEXT NOT NULL DEFAULT 'word'
      CHECK (type IN ('word', 'chunk'));

      UPDATE vocabulary_words
      SET type = 'chunk'
      WHERE INSTR(TRIM(word), ' ') > 0;
    `);
  }
}

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vocabulary_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
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
  `);

  migrateDb(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vocabulary_type_score_created
    ON vocabulary_words(type, score, createdAt);
  `);

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

  const displayWord = word.trim();
  const normalizedWord = displayWord.toLowerCase();
  const normalizedMeaning = meaning.trim();

  if (!normalizedWord) {
    throw new Error("word cannot be empty.");
  }

  if (!normalizedMeaning) {
    throw new Error("meaning cannot be empty.");
  }

  const db = openDb();

  const existing = db
    .prepare(
      `
      SELECT id, word, type, meaning, score, createdAt
      FROM vocabulary_words
      WHERE LOWER(word) = LOWER(?)
    `,
    )
    .get(displayWord) as VocabWord | undefined;

  if (existing) {
    output({
      ok: true,
      action: "exists",
      word: existing,
    });
    return;
  }

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

  output({
    ok: true,
    action: "created",
    word: created,
  });
}

function makeHint(word: string): string {
  return word.split(" ").map((part) => part[0] + "•".repeat(part.length - 1))
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

function formatQuiz(
  items: VocabWord[],
  session?: QuizSession,
  stats?: QuizStats,
) {
  const formattedItems = items.map((item) => {
    const meaningOneLine = item.meaning.replace(/\n/g, "；");
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

  output({
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
  });
}

function startQuizSession(db: DatabaseSync, total: number) {
  const words = selectQuizWords(db, total);
  const session: QuizSession = {
    id: createId(),
    totalCount: words.length,
    nextPosition: 0,
  };

  db.exec("BEGIN");
  try {
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

  const session = sessionId
    ? db.prepare(
      `
      SELECT id, totalCount, nextPosition
      FROM quiz_sessions
      WHERE id = ?
    `,
    ).get(sessionId) as QuizSession | undefined
    : startQuizSession(db, total!);

  if (!session) {
    throw new Error(`quiz session not found: ${sessionId}`);
  }

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
  db.prepare(
    `
    UPDATE quiz_sessions
    SET nextPosition = ?
    WHERE id = ?
  `,
  ).run(session.nextPosition, session.id);

  formatQuiz(items, session, getQuizStats(db, session.id));
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
      output({
        ok: true,
        action: "already_answered",
        id,
        word: sessionWord.word,
        result: sessionWord.savedResult,
        userAnswer: sessionWord.savedUserAnswer,
        ...getQuizStats(db, sessionId),
      });
      return;
    }

    const oldScore = sessionWord.score;
    const newScore = result === "correct"
      ? oldScore + 1
      : Math.max(0, oldScore - 2);

    db.exec("BEGIN IMMEDIATE");
    try {
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
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    output({
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
    });
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

const DICT_PATH = "./data/dict.db";

function openDict() {
  return new DatabaseSync(DICT_PATH);
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
    .get(word.trim()) as DictEntry | undefined;

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

  const displayWord = word.trim();
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
      WHERE LOWER(word) = LOWER(?)
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

function main() {
  const [command, ...args] = Deno.args;

  try {
    if (command === "add") {
      addWord(args[0], args.slice(1).join(" "));
      return;
    }

    if (command === "quiz") {
      const limitIndex = args.indexOf("--limit");
      const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 5;
      const totalIndex = args.indexOf("--total");
      const total = totalIndex >= 0 ? Number(args[totalIndex + 1]) : undefined;
      const sessionIndex = args.indexOf("--session");
      const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
      getQuiz(limit, total, sessionId);
      return;
    }

    if (command === "answer") {
      const sessionIndex = args.indexOf("--session");
      const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
      const inputIndex = args.indexOf("--input");
      const userAnswer = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
      answerWord(args[0], args[1], sessionId, userAnswer);
      return;
    }

    if (command === "quiz-result") {
      const sessionIndex = args.indexOf("--session");
      const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
      getQuizResult(sessionId);
      return;
    }

    if (command === "update") {
      updateWord(args[0], args.slice(1).join(" "));
      return;
    }

    if (command === "list") {
      listWords();
      return;
    }

    if (command === "lookup") {
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
      ],
    });
  } catch (error) {
    output({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });

    Deno.exit(1);
  }
}

main();
