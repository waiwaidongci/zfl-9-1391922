const sessions = new Map();

const SESSION_TTL = 30 * 60 * 1000;

function generateSessionId() {
  return `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export function createImportSession(rows, previewResult) {
  const sessionId = generateSessionId();
  const now = new Date();
  const session = {
    id: sessionId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL).toISOString(),
    rows,
    preview: previewResult,
    status: "previewed",
    submittedRows: [],
    submittedAt: null,
    cancelledAt: null,
    metadata: {
      rowCount: rows.length,
      validCount: previewResult.validCount,
      errorCount: previewResult.errorCount
    }
  };
  sessions.set(sessionId, session);
  return session;
}

export function getImportSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function updateImportSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session, updates);
  sessions.set(sessionId, session);
  return session;
}

export function cancelImportSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.status === "submitted") return { error: "already_submitted" };
  session.status = "cancelled";
  session.cancelledAt = new Date().toISOString();
  sessions.set(sessionId, session);
  return session;
}

export function deleteImportSession(sessionId) {
  return sessions.delete(sessionId);
}

export function listImportSessions({ status, limit = 20, offset = 0 } = {}) {
  cleanExpiredSessions();
  let all = [...sessions.values()];
  if (status) {
    all = all.filter((s) => s.status === status);
  }
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = all.length;
  const page = all.slice(offset, offset + limit);
  return {
    total,
    offset,
    limit,
    sessions: page.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      status: s.status,
      rowCount: s.metadata.rowCount,
      validCount: s.metadata.validCount,
      errorCount: s.metadata.errorCount,
      submittedAt: s.submittedAt || null,
      cancelledAt: s.cancelledAt || null
    }))
  };
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

export function getSessionCount() {
  return sessions.size;
}
