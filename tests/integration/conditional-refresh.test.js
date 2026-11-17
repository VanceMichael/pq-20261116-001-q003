import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchive, page, standardItems, baseFeed } from "../helpers.js";
import { NewsArchive } from "../../src/service/archive.js";
import { PageFetcher } from "../../src/acquisition/page-fetcher.js";
import { buildConditionalHeaders } from "../../src/acquisition/http-validators.js";

const FEED_URL = baseFeed.baseUrl;

/**
 * A controllable origin that speaks conditional requests like a real source:
 * it maps a URL to the current representation, records the request headers and
 * answers 304 when the supplied validator matches the representation it holds.
 * `publish` swaps the body/metadata; `stall` makes the origin answer 304 for
 * the current representation without changing it.
 */
function conditionalOrigin(initial) {
  const state = new Map();
  const requests = [];
  state.set(FEED_URL, { ...initial });
  return {
    requests,
    publish(url, { html, etag, lastModified = null }) {
      state.set(url, { html, etag, lastModified });
    },
    // Serve an unchanged representation. If the caller sends a validator it is
    // matched; a caller without validators still receives the stored body.
    async handle(url, headers) {
      requests.push({ url, headers: { ...headers } });
      const current = state.get(url);
      if (!current) return new Response("gone", { status: 404 });
      const ifNoneMatch = headers["if-none-match"];
      const ifModifiedSince = headers["if-modified-since"];
      const matchesEtag = ifNoneMatch != null && ifNoneMatch === current.etag;
      const matchesDate = ifModifiedSince != null && current.lastModified != null
        && ifModifiedSince === current.lastModified;
      if (matchesEtag || matchesDate) {
        const response = new Response(null, { status: 304 });
        return response;
      }
      return new Response(current.html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: current.etag,
          ...(current.lastModified ? { "last-modified": current.lastModified } : {})
        }
      });
    }
  };
}

function originFetcher(origin) {
  const fetcher = new PageFetcher({
    fetchImpl: async (url, options) => origin.handle(url, options.headers),
    sleep: async () => {},
    now: () => Date.parse("2026-11-16T02:00:00Z")
  });
  return fetcher;
}

function sequenceClock(start = "2026-11-16T02:00:00.000Z", stepSeconds = 1) {
  let current = Date.parse(start);
  return () => {
    const value = new Date(current);
    current += stepSeconds * 1000;
    return value;
  };
}

test("a good page then an unchanged 304 yields one accepted capture and no extra observations", async (t) => {
  const html = page(standardItems(4));
  const origin = conditionalOrigin({ html, etag: '"v1"' });
  const { archive } = await makeArchive(t, { fetcher: originFetcher(origin), clock: sequenceClock() });
  archive.registerFeed(baseFeed);

  const first = await archive.refreshFeed("daily-main");
  assert.equal(first.outcome, "accepted");
  assert.equal(first.httpStatus, 200);
  assert.equal(first.capture.accepted, true);

  const second = await archive.refreshFeed("daily-main");
  assert.equal(second.outcome, "not_modified");
  assert.equal(second.httpStatus, 304);
  assert.equal(second.capture, null);
  assert.deepEqual(second.notModified, {
    contentState: "accepted",
    captureId: first.capture.captureId,
    capturedAt: first.capture.capturedAt,
    accepted: true,
    reason: null,
    itemCount: 4
  });

  // The conditional header actually carried the stored validator.
  assert.equal(origin.requests.length, 2);
  assert.equal(origin.requests[1].headers["if-none-match"], '"v1"');
  assert.equal(origin.requests[1].headers.accept, origin.requests[0].headers.accept);

  const stats = archive.articles.stats("daily-main");
  assert.equal(stats.total, 4);
  assert.ok(archive.listItems("daily-main").items.every((item) => item.seenCount === 1));
  assert.equal(archive.listCaptures("daily-main").length, 1);
  assert.equal(archive.feedHealth("daily-main").totals.notModified, 1);
});

test("an incomplete 200 page with a new ETag is rejected and the later 304 refers to that rejected page", async (t) => {
  const good = page(standardItems(8));
  const broken = page(standardItems(2, 20));
  const origin = conditionalOrigin({ html: good, etag: '"good-1"' });
  const { archive } = await makeArchive(t, { fetcher: originFetcher(origin), clock: sequenceClock() });
  archive.registerFeed(baseFeed);

  const accepted = await archive.refreshFeed("daily-main");
  assert.equal(accepted.outcome, "accepted");

  // The site truncates the page but ships a brand-new ETag. The body must not
  // advance the accepted list...
  origin.publish(FEED_URL, { html: broken, etag: '"broken-1"' });
  const rejected = await archive.refreshFeed("daily-main");
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.httpStatus, 200);
  assert.equal(rejected.capture.accepted, false);
  assert.match(rejected.capture.reason, /too_few_usable_items/);
  assert.equal(archive.listItems("daily-main").statistics.visible, 8);
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, accepted.capture.capturedAt);

  // ...and when the next request is answered 304, it must resolve to the
  // rejected representation rather than masquerading as a fresh collection.
  const notModified = await archive.refreshFeed("daily-main");
  assert.equal(notModified.outcome, "not_modified");
  assert.equal(notModified.notModified.contentState, "rejected");
  assert.equal(notModified.notModified.captureId, rejected.capture.captureId);
  assert.equal(notModified.notModified.accepted, false);
  assert.match(notModified.notModified.reason, /too_few_usable_items/);
  assert.equal(notModified.capture, null);

  // No article observation was created from the broken page or the 304.
  assert.equal(archive.listItems("daily-main").statistics.total, 8);
  assert.ok(archive.listItems("daily-main").items.every((item) => item.seenCount === 1));
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, accepted.capture.capturedAt);

  const health = archive.feedHealth("daily-main");
  assert.equal(health.totals.accepted, 1);
  assert.equal(health.totals.rejected, 1);
  assert.equal(health.totals.notModified, 1);
  assert.equal(health.totals.notModifiedRejected, 1);
  assert.ok(health.issues.some((issue) => issue.code === "capture_rejections"));
  assert.ok(health.issues.some((issue) => issue.code === "not_modified_rejected_capture"));
  // The 304 audit row points at a capture without inventing observations.
  assert.equal(archive.auditIntegrity().status, "consistent");
  const attempts = archive.listFetchAttempts("daily-main");
  assert.equal(attempts[0].outcome, "not_modified");
  assert.equal(attempts[0].captureId, rejected.capture.captureId);
  assert.equal(attempts[0].errorCode, "referred_capture_rejected");
});

test("validators survive a restart and a 304 still resolves to its capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-restart-"));
  const filename = join(directory, "archive.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const html = page(standardItems(5));
  const origin = conditionalOrigin({ html, etag: '"restart-v1"', lastModified: "2026-11-16T01:00:00Z" });

  const first = new NewsArchive(filename, { fetcher: originFetcher(origin), clock: sequenceClock() });
  first.registerFeed(baseFeed);
  const accepted = await first.refreshFeed("daily-main");
  assert.equal(accepted.outcome, "accepted");
  const validators = first.feedStatus("daily-main").sourceValidators;
  assert.deepEqual(validators.map((row) => [row.sourceUrl, row.etag, row.captureId]),
    [[FEED_URL, '"restart-v1"', accepted.capture.captureId]]);
  first.close();

  // New process, same database file: the stored validator is still sent.
  const second = new NewsArchive(filename, { fetcher: originFetcher(origin), clock: sequenceClock() });
  t.after(() => second.close());
  const notModified = await second.refreshFeed("daily-main");
  assert.equal(notModified.outcome, "not_modified");
  assert.equal(origin.requests.at(-1).headers["if-none-match"], '"restart-v1"');
  assert.equal(origin.requests.at(-1).headers["if-modified-since"], "2026-11-16T01:00:00Z");
  assert.equal(notModified.notModified.captureId, accepted.capture.captureId);
  assert.equal(notModified.notModified.contentState, "accepted");
  assert.equal(second.articles.stats("daily-main").total, 5);
  assert.equal(second.listCaptures("daily-main").length, 1);
});

test("changing the source URL never carries over validators from the old page", async (t) => {
  const oldUrl = FEED_URL;
  const newUrl = "https://news.example.test/scroll-news/news2.html";
  const origin = conditionalOrigin({
    html: page(standardItems(4)), etag: '"old-page"', lastModified: "2026-11-16T01:00:00Z"
  });
  origin.publish(newUrl, { html: page(standardItems(4, 10)), etag: '"new-page"', lastModified: "2026-11-16T01:30:00Z" });
  const { archive } = await makeArchive(t, { fetcher: originFetcher(origin), clock: sequenceClock() });
  archive.registerFeed(baseFeed);
  const old = await archive.refreshFeed("daily-main");
  assert.equal(old.outcome, "accepted");

  archive.registerFeed({ ...baseFeed, baseUrl: newUrl });
  const moved = await archive.refreshFeed("daily-main");
  // The first request to the new URL must be unconditional; otherwise the old
  // page's validator could convince the origin to answer 304 for a page we
  // have never captured.
  assert.equal(origin.requests.at(-1).url, newUrl);
  assert.equal(origin.requests.at(-1).headers["if-none-match"], undefined);
  assert.equal(origin.requests.at(-1).headers["if-modified-since"], undefined);
  assert.equal(moved.outcome, "accepted");
  assert.equal(moved.capture.normalizedCount, 4);
  assert.equal(archive.feedStatus("daily-main").sourceValidators.length, 1);
  assert.equal(archive.feedStatus("daily-main").sourceValidators[0].sourceUrl, newUrl);

  // A following 304 now refers to the new page, not the abandoned one.
  const notModified = await archive.refreshFeed("daily-main");
  assert.equal(notModified.outcome, "not_modified");
  assert.equal(notModified.notModified.captureId, moved.capture.captureId);
  assert.equal(origin.requests.at(-1).headers["if-none-match"], '"new-page"');
});

test("a failed conditional fetch keeps the last validators so the next refresh can retry", async (t) => {
  const origin = conditionalOrigin({ html: page(standardItems(4)), etag: '"keep-me"' });
  const base = originFetcher(origin);
  let failNext = false;
  const fetcher = {
    async fetchFeed(feed, options) {
      if (failNext) throw Object.assign(new Error("temporary outage"), { code: "fetch_failed", attemptCount: 2 });
      return base.fetchFeed(feed, options);
    }
  };
  const { archive } = await makeArchive(t, { fetcher, clock: sequenceClock() });
  archive.registerFeed(baseFeed);
  const accepted = await archive.refreshFeed("daily-main");
  failNext = true;
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "fetch_failed" });
  assert.equal(archive.feedStatus("daily-main").sourceValidators[0].captureId, accepted.capture.captureId);
  failNext = false;
  const retried = await archive.refreshFeed("daily-main");
  assert.equal(retried.outcome, "not_modified");
  assert.equal(retried.notModified.captureId, accepted.capture.captureId);
});

test("an unexpected 304 without any stored validator fails instead of claiming not-modified", async (t) => {
  const fetcher = {
    async fetchFeed() {
      throw Object.assign(new Error("source returned HTTP 304 without a conditional request"),
        { code: "unexpected_not_modified", attemptCount: 1 });
    }
  };
  const { archive } = await makeArchive(t, { fetcher, clock: sequenceClock() });
  archive.registerFeed(baseFeed);
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "unexpected_not_modified" });
  const [attempt] = archive.listFetchAttempts("daily-main");
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.httpStatus, null);
});

test("a 200 page without validators clears stale validators rather than reusing them", async (t) => {
  const origin = conditionalOrigin({ html: page(standardItems(4)), etag: '"present"' });
  const { archive } = await makeArchive(t, { fetcher: originFetcher(origin), clock: sequenceClock() });
  archive.registerFeed(baseFeed);
  await archive.refreshFeed("daily-main");
  assert.equal(archive.feedStatus("daily-main").sourceValidators.length, 1);

  // The source stops emitting validators. Storing the old one would make a
  // later unconditional 200 look conditional, so it must be dropped.
  origin.publish(FEED_URL, { html: `${page(standardItems(4))}\n<!-- no validators -->`, etag: null });
  const refreshed = await archive.refreshFeed("daily-main");
  assert.equal(refreshed.outcome, "accepted");
  assert.equal(archive.feedStatus("daily-main").sourceValidators.length, 0);
  const next = await archive.refreshFeed("daily-main");
  assert.equal(next.outcome, "accepted");
  assert.equal(origin.requests.at(-1).headers["if-none-match"], undefined);
});

test("conditional headers are only sent while the original URL is requested", async (t) => {
  // Redirect support exists for CDNs; validators must not follow the hop.
  const requested = [];
  const fetcher = new PageFetcher({
    fetchImpl: async (url, options) => {
      requested.push({ url, headers: options.headers });
      if (requested.length === 1) return new Response(null, { status: 302, headers: { location: "/moved.html" } });
      return new Response(page(standardItems(4)), { headers: { "content-type": "text/html", etag: '"moved"' } });
    },
    sleep: async () => {}
  });
  const { archive } = await makeArchive(t, { fetcher, clock: sequenceClock() });
  archive.registerFeed(baseFeed);
  await archive.refreshFeed("daily-main");
  assert.equal(requested[1].headers["if-none-match"], undefined);
});

test("buildConditionalHeaders refuses malformed or unsafe validators", () => {
  assert.deepEqual(buildConditionalHeaders({ etag: '"ok"', lastModified: "2026-11-16T01:00:00Z" }), {
    "if-none-match": '"ok"',
    "if-modified-since": "2026-11-16T01:00:00Z"
  });
  assert.deepEqual(buildConditionalHeaders({ etag: 'no-quotes', lastModified: "not a date" }), {});
  assert.deepEqual(buildConditionalHeaders({ etag: '"crlf"\r\nX-Injected: 1' }), {});
});
