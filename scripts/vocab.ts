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

function getQuiz(limit = 30) {
  const db = openDb();

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

  const raw = [...learning, ...mastering, ...skilled, ...expert].slice(
    0,
    limit,
  );

  const items = raw.map((item) => {
    const meaningOneLine = item.meaning.replace(/\n/g, "；");
    const hint = makeHint(item.word);
    const isPhrase = item.type === "chunk";
    const displayLine = isPhrase
      ? `${meaningOneLine} (${hint}) [短语]`
      : `${meaningOneLine} (${hint})`;
    return { ...item, hint, isPhrase, displayLine };
  });

  const displayBlock = items
    .map((item, i) => `${i + 1}. ${item.displayLine}`)
    .join("\n");

  const answers = items.map((item) => ({ id: item.id, word: item.word }));

  output({
    ok: true,
    count: items.length,
    displayBlock,
    answers,
  });
}

function answerWord(id: string | undefined, result: string | undefined) {
  if (!id || !result) {
    throw new Error("Usage: deno task answer <id> correct|wrong");
  }

  if (result !== "correct" && result !== "wrong") {
    throw new Error("result must be correct or wrong.");
  }

  const db = openDb();

  const word = db
    .prepare(
      `
      SELECT id, word, type, meaning, score, createdAt
      FROM vocabulary_words
      WHERE id = ?
    `,
    )
    .get(id) as VocabWord | undefined;

  if (!word) {
    throw new Error(`word not found: ${id}`);
  }

  const oldScore = word.score;
  const newScore = result === "correct"
    ? oldScore + 1
    : Math.max(0, oldScore - 2);

  db.prepare(
    `
    UPDATE vocabulary_words
    SET score = ?
    WHERE id = ?
  `,
  ).run(newScore, id);

  output({
    ok: true,
    id,
    word: word.word,
    meaning: word.meaning,
    result,
    oldScore,
    newScore,
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
      const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 30;
      getQuiz(Number.isFinite(limit) ? limit : 30);
      return;
    }

    if (command === "answer") {
      answerWord(args[0], args[1]);
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
        "quiz --limit 30",
        "answer <id> correct|wrong",
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
