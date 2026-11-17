import { normalizeEtag, normalizeLastModified } from "../acquisition/http-validators.js";

/**
 * Stores the HTTP response validators (ETag / Last-Modified) together with the
 * capture whose representation they describe. Persisting the pair means a
 * later 304 can still be resolved to a concrete page and acceptance result
 * after a restart.
 */
export class ValidatorRepository {
  constructor(database) {
    this.database = database;
    this.findQuery = database.prepare(`SELECT feed_id, source_url, etag, last_modified, capture_id, updated_at
      FROM source_validators WHERE feed_id=? AND source_url=?`);
    this.listQuery = database.prepare(`SELECT feed_id, source_url, etag, last_modified, capture_id, updated_at
      FROM source_validators WHERE feed_id=? ORDER BY source_url`);
    this.upsert = database.prepare(`INSERT INTO source_validators
      (feed_id, source_url, etag, last_modified, capture_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, source_url) DO UPDATE SET etag=excluded.etag,
        last_modified=excluded.last_modified, capture_id=excluded.capture_id, updated_at=excluded.updated_at`);
    this.remove = database.prepare("DELETE FROM source_validators WHERE feed_id=? AND source_url=?");
    this.removeOthers = database.prepare("DELETE FROM source_validators WHERE feed_id=? AND source_url<>?");
  }

  find(feedId, sourceUrl) {
    const row = this.findQuery.get(feedId, sourceUrl);
    return row ? mapValidator(row) : null;
  }

  all(feedId) {
    return this.listQuery.all(feedId).map(mapValidator);
  }

  record({ feedId, sourceUrl, etag = null, lastModified = null, captureId = null, updatedAt }) {
    const safeEtag = normalizeEtag(etag);
    const safeLastModified = normalizeLastModified(lastModified);
    if (!safeEtag && !safeLastModified) {
      this.clear(feedId, sourceUrl);
      return null;
    }
    this.upsert.run(feedId, sourceUrl, safeEtag, safeLastModified, captureId, updatedAt);
    return this.find(feedId, sourceUrl);
  }

  clear(feedId, sourceUrl) {
    this.remove.run(feedId, sourceUrl);
  }

  /** A changed feed URL must never inherit validators from the old page. */
  retainOnly(feedId, sourceUrl) {
    this.removeOthers.run(feedId, sourceUrl);
  }
}

function mapValidator(row) {
  return {
    feedId: row.feed_id,
    sourceUrl: row.source_url,
    etag: row.etag,
    lastModified: row.last_modified,
    captureId: row.capture_id === null ? null : Number(row.capture_id),
    updatedAt: row.updated_at
  };
}
