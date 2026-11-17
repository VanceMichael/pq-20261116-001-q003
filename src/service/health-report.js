const WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export class HealthReportService {
  constructor({ feeds, fetches, clock = () => new Date() }) {
    this.feeds = feeds;
    this.fetches = fetches;
    this.clock = clock;
  }

  report(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const now = this.clock();
    const summary = this.fetches.summarySince(feedId, new Date(now.getTime() - WINDOW_MS).toISOString());
    // A network-confirmed source is fresh whether it served new content (200
    // accepted) or said the representation was unchanged (304). A 304 that
    // resolves to a rejected page is deliberately not counted as confirmation.
    const lastConfirmed = summary.lastConfirmedAt ? Date.parse(summary.lastConfirmedAt) : null;
    const ageMs = lastConfirmed === null ? null : Math.max(0, now.getTime() - lastConfirmed);
    const issues = diagnose(summary, ageMs);
    return {
      feedId,
      status: summary.total === 0 ? "awaiting_capture" : issues.length ? "attention" : "healthy",
      checkedAt: now.toISOString(),
      windowHours: 24,
      lastSuccessAt: summary.lastSuccessAt ?? null,
      lastConfirmedAt: summary.lastConfirmedAt ?? null,
      lastAttemptAt: summary.lastAttemptAt ?? null,
      outcomes: {
        acceptedAt: summary.lastAcceptedAt ?? null,
        notModifiedAt: summary.lastNotModifiedAt ?? null,
        rejectedAt: summary.lastRejectedAt ?? null,
        failedAt: summary.lastFailedAt ?? null
      },
      freshness: ageMs === null ? "unknown" : ageMs > STALE_AFTER_MS ? "stale" : "fresh",
      successRate: summary.total ? Number((summary.accepted / summary.total).toFixed(3)) : null,
      totals: {
        attempts: summary.total,
        accepted: summary.accepted,
        rejected: summary.rejected,
        failed: summary.failed,
        notModified: summary.notModified,
        notModifiedRejected: summary.notModifiedRejected
      },
      issues
    };
  }
}

function diagnose(summary, ageMs) {
  const issues = [];
  if (!summary.total) issues.push({ code: "no_recent_attempts", severity: "warning" });
  if (summary.failed > 0) issues.push({ code: "source_failures", severity: "warning", count: summary.failed });
  if (summary.rejected > 0) issues.push({ code: "capture_rejections", severity: "warning", count: summary.rejected });
  if (summary.notModifiedRejected > 0) {
    // The source keeps confirming an incomplete page with a 304. Network-wise
    // it answered, but archive content is not advancing.
    issues.push({ code: "not_modified_rejected_capture", severity: "warning", count: summary.notModifiedRejected });
  }
  if (ageMs === null && summary.total > 0) issues.push({ code: "no_successful_capture", severity: "critical" });
  if (ageMs !== null && ageMs > STALE_AFTER_MS) {
    issues.push({ code: "stale_source", severity: "critical", ageHours: Number((ageMs / 3_600_000).toFixed(1)) });
  }
  // Judge quality only on responses that actually carried a page. A run of
  // healthy 304s must not look like a run of rejected content.
  const contentAttempts = summary.total - summary.notModified;
  if (contentAttempts >= 4 && summary.accepted / contentAttempts < 0.5) {
    issues.push({ code: "low_acceptance_rate", severity: "critical",
      rate: Number((summary.accepted / contentAttempts).toFixed(3)) });
  }
  return issues;
}
