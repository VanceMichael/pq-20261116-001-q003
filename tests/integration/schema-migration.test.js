import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NewsArchive } from "../../src/service/archive.js";
import { SCHEMA_VERSION } from "../../src/store/database.js";
import { baseFeed, page, standardItems } from "../helpers.js";

test("upgrades an existing version 1 archive in place without losing captures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-migrate-"));
  const filename = join(directory, "archive.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE feeds (
      feed_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, allowed_hosts_json TEXT NOT NULL,
      minimum_items INTEGER NOT NULL DEFAULT 3, missing_threshold INTEGER NOT NULL DEFAULT 3,
      last_accepted_at TEXT, last_item_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE captures (
      capture_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      fingerprint TEXT NOT NULL, captured_at TEXT NOT NULL,
      accepted INTEGER NOT NULL CHECK(accepted IN (0, 1)),
      candidate_count INTEGER NOT NULL, normalized_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL, reason TEXT,
      UNIQUE(feed_id, fingerprint)
    );
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      canonical_url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1, missing_streak INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible', 'quiet')),
      review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed', 'confirmed', 'withdrawn')),
      review_note TEXT, review_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(feed_id, canonical_url)
    );
    CREATE TABLE capture_items (
      capture_id INTEGER NOT NULL REFERENCES captures(capture_id) ON DELETE CASCADE,
      article_id INTEGER NOT NULL REFERENCES articles(article_id),
      source_index INTEGER NOT NULL, PRIMARY KEY(capture_id, article_id)
    );
    CREATE TABLE fetch_attempts (
      attempt_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'not_modified', 'failed')),
      http_status INTEGER, attempt_count INTEGER NOT NULL,
      requested_url TEXT NOT NULL, final_url TEXT,
      capture_id INTEGER REFERENCES captures(capture_id), error_code TEXT, error_message TEXT
    );
    CREATE TABLE review_events (
      event_id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(article_id),
      prior_state TEXT NOT NULL, next_state TEXT NOT NULL, note TEXT,
      revision INTEGER NOT NULL, changed_at TEXT NOT NULL
    );
    INSERT INTO feeds VALUES ('daily-main', 'https://news.example.test/scroll-news/news1.html',
      '["news.example.test"]', 3, 3, NULL, 0, '2026-11-16T02:00:00.000Z', '2026-11-16T02:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const archive = new NewsArchive(filename);
  t.after(() => archive.close());
  assert.equal(archive.database.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(archive.feedStatus("daily-main").baseUrl, baseFeed.baseUrl);
  assert.equal(archive.auditIntegrity().status, "consistent");

  // The upgraded archive can store validators through a normal refresh flow.
  archive.registerFeed(baseFeed);
  const imported = archive.importSnapshot("daily-main", page(standardItems(4)), "2026-11-16T02:00:01.000Z");
  assert.equal(imported.accepted, true);
  assert.deepEqual(archive.listCaptures("daily-main").length, 1);
});
