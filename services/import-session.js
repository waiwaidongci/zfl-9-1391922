const sessions = new Map();

const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

export const SESSION_STATUSES = {
  PREVIEWED: "previewed",
  SUBMITTED: "submitted",
  EXPIRED: "expired",
  CANCELLED: "cancelled"
};

let cleanupTimer = null;
let stats = {
  created: 0,
  submitted: 0,
  expired: 0,
  cancelled: 0,
  cleanupRuns: 0
};

function generateSessionId() {
  return `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  if (typeof setInterval !== "function") return;
  cleanupTimer = setInterval(() => {
    const cleaned = cleanExpiredSessions();
    stats.cleanupRuns++;
    stats.expired += cleaned;
  }, CLEANUP_INTERVAL);
  if (cleanupTimer.unref && typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
}

function evictOldestIfNeeded() {
  if (sessions.size < MAX_SESSIONS) return;
  let oldestId = null;
  let oldestTime = Infinity;
  for (const [id, session] of sessions) {
    const t = new Date(session.createdAt).getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestId = id;
    }
  }
  if (oldestId) {
    sessions.delete(oldestId);
    stats.expired++;
  }
}

export function createImportSession(rows, previewResult) {
  ensureCleanupTimer();
  evictOldestIfNeeded();

  const sessionId = generateSessionId();
  const now = new Date();
  const session = {
    id: sessionId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL).toISOString(),
    ttl: SESSION_TTL,
    rows,
    preview: previewResult,
    status: SESSION_STATUSES.PREVIEWED,
    submittedRows: [],
    submittedAt: null,
    summary: null,
    metadata: {
      rowCount: rows.length,
      previewValidCount: previewResult?.validCount || 0,
      previewErrorCount: previewResult?.errorCount || 0
    }
  };
  sessions.set(sessionId, session);
  stats.created++;
  return session;
}

export function getImportSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    sessions.delete(sessionId);
    stats.expired++;
    return null;
  }
  return session;
}

export function updateImportSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session, updates);
  if (updates.status === SESSION_STATUSES.SUBMITTED) {
    stats.submitted++;
  }
  sessions.set(sessionId, session);
  return session;
}

export function cancelImportSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.status === SESSION_STATUSES.SUBMITTED) {
    return null;
  }
  session.status = SESSION_STATUSES.CANCELLED;
  session.cancelledAt = new Date().toISOString();
  stats.cancelled++;
  sessions.set(sessionId, session);
  return session;
}

export function deleteImportSession(sessionId) {
  return sessions.delete(sessionId);
}

export function cleanExpiredSessions() {
  const now = new Date();
  let count = 0;
  for (const [id, session] of sessions) {
    if (new Date(session.expiresAt) < now) {
      sessions.delete(id);
      count++;
    }
  }
  return count;
}

export function listImportSessions(options = {}) {
  const {
    status = null,
    limit = 100,
    offset = 0,
    includeRows = false
  } = options;

  let all = Array.from(sessions.values());
  if (status) {
    all = all.filter((s) => s.status === status);
  }
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = all.length;
  const paged = all.slice(offset, offset + limit);

  const items = paged.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    status: s.status,
    metadata: s.metadata,
    submittedAt: s.submittedAt || null,
    summary: s.summary || null,
    rowCount: includeRows ? s.rows?.length : undefined,
    rows: includeRows ? s.rows : undefined
  }));

  return {
    total,
    count: items.length,
    limit,
    offset,
    items
  };
}

export function getImportSessionStats() {
  cleanExpiredSessions();
  return {
    active: sessions.size,
    created: stats.created,
    submitted: stats.submitted,
    expired: stats.expired,
    cancelled: stats.cancelled,
    cleanupRuns: stats.cleanupRuns,
    maxSessions: MAX_SESSIONS,
    sessionTtlMs: SESSION_TTL,
    cleanupIntervalMs: CLEANUP_INTERVAL
  };
}
