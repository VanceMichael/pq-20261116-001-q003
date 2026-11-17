export class RefreshService {
  constructor({ feeds, fetches, fetcher, imports, validators, captures, clock = () => new Date() }) {
    this.feeds = feeds;
    this.fetches = fetches;
    this.fetcher = fetcher;
    this.imports = imports;
    this.validators = validators;
    this.captures = captures;
    this.clock = clock;
    this.inFlight = new Map();
  }

  refresh(feedId) {
    const active = this.inFlight.get(feedId);
    if (active) return active;
    const task = this.perform(feedId).finally(() => {
      if (this.inFlight.get(feedId) === task) this.inFlight.delete(feedId);
    });
    this.inFlight.set(feedId, task);
    return task;
  }

  async perform(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const startedAt = this.clock().toISOString();
    // Validators are scoped to the exact configured source URL. After an
    // operator changes baseUrl the old page's validators are never reused.
    const stored = this.validators.find(feedId, feed.baseUrl);
    try {
      const fetched = await this.fetcher.fetchFeed(feed, { validators: stored });
      const finishedAt = this.clock().toISOString();
      if (fetched.status === 304) {
        return this.recordNotModified(feed, stored, fetched, startedAt, finishedAt);
      }
      return this.recordPage(feed, fetched, startedAt, finishedAt);
    } catch (error) {
      const finishedAt = this.clock().toISOString();
      const attemptId = this.fetches.record({
        feedId, startedAt, finishedAt, outcome: "failed", httpStatus: error.status ?? null,
        attemptCount: error.attemptCount ?? 1, requestedUrl: feed.baseUrl, finalUrl: null,
        captureId: null, errorCode: error.code ?? "refresh_failed", errorMessage: error.message.slice(0, 500)
      });
      throw Object.assign(error, { attemptId, statusCode: error.statusCode ?? 502 });
    }
  }

  recordPage(feed, fetched, startedAt, finishedAt) {
    const capture = this.imports.importHtml(feed.feedId, fetched.html, finishedAt);
    const attemptId = this.fetches.record({
      feedId: feed.feedId, startedAt, finishedAt,
      outcome: capture.accepted ? "accepted" : "rejected",
      httpStatus: fetched.status, attemptCount: fetched.attemptCount,
      requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
      captureId: capture.captureId ?? null, errorCode: capture.accepted ? null : "capture_rejected",
      errorMessage: capture.reason
    });
    // A rejected partial page still owns its validators: a later 304 refers to
    // that rejected representation, never silently to an older accepted one.
    this.validators.record({
      feedId: feed.feedId,
      sourceUrl: feed.baseUrl,
      etag: fetched.validators?.etag,
      lastModified: fetched.validators?.lastModified,
      captureId: capture.captureId ?? null,
      updatedAt: finishedAt
    });
    return {
      attemptId, feedId: feed.feedId, outcome: capture.accepted ? "accepted" : "rejected",
      httpStatus: fetched.status, capture
    };
  }

  recordNotModified(feed, stored, fetched, startedAt, finishedAt) {
    // The 304 cannot be read directly. Resolve it through the validator that
    // was sent so the response still points at a known capture and outcome.
    const referred = stored?.captureId ? this.captures.get(stored.captureId) : null;
    const attemptId = this.fetches.record({
      feedId: feed.feedId, startedAt, finishedAt, outcome: "not_modified", httpStatus: 304,
      attemptCount: fetched.attemptCount, requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl, captureId: referred?.captureId ?? null,
      errorCode: referred && !referred.accepted ? "referred_capture_rejected" : null,
      errorMessage: referred && !referred.accepted ? referred.reason : null
    });
    if (stored && fetched.validators && (fetched.validators.etag || fetched.validators.lastModified)) {
      // A 304 may refresh the validator pair; the entity is unchanged.
      this.validators.record({
        feedId: feed.feedId,
        sourceUrl: feed.baseUrl,
        etag: fetched.validators.etag ?? stored.etag,
        lastModified: fetched.validators.lastModified ?? stored.lastModified,
        captureId: referred?.captureId ?? stored.captureId ?? null,
        updatedAt: finishedAt
      });
    }
    const contentState = referred ? (referred.accepted ? "accepted" : "rejected") : "unknown";
    return {
      attemptId, feedId: feed.feedId, outcome: "not_modified", httpStatus: 304, capture: null,
      notModified: {
        contentState,
        captureId: referred?.captureId ?? null,
        capturedAt: referred?.capturedAt ?? null,
        accepted: referred ? referred.accepted : null,
        reason: referred?.reason ?? null,
        itemCount: referred?.normalizedCount ?? null
      }
    };
  }

  recent(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.fetches.recent(feedId, limit);
  }

  pending(feedId) {
    return this.inFlight.has(feedId);
  }
}
