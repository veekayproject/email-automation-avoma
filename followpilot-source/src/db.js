import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dbPath = config.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(config.DATABASE_PATH);
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'avoma',
    title TEXT NOT NULL,
    meeting_date TEXT,
    owner_name TEXT,
    owner_email TEXT,
    prospect_name TEXT,
    prospect_company TEXT,
    recipient_email TEXT,
    meeting_url TEXT,
    crm_url TEXT,
    participants_json TEXT NOT NULL DEFAULT '[]',
    source_payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    recipient TEXT NOT NULL,
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    generation_json TEXT,
    slack_channel TEXT,
    slack_ts TEXT,
    review_token TEXT NOT NULL UNIQUE,
    approved_by TEXT,
    sent_at TEXT,
    outlook_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    email TEXT PRIMARY KEY,
    display_name TEXT,
    microsoft_user_id TEXT,
    refresh_token_encrypted TEXT NOT NULL,
    access_token_encrypted TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    ae_email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    event TEXT NOT NULL,
    actor TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
  CREATE INDEX IF NOT EXISTS idx_audit_meeting ON audit_logs(meeting_id);
`);

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

export function audit(meetingId, event, details = {}, actor = 'system') {
  db.prepare('INSERT INTO audit_logs (meeting_id,event,actor,details_json,created_at) VALUES (?,?,?,?,?)')
    .run(meetingId || null, event, actor, json(details), now());
}

export function createMeeting(input) {
  const time = now();
  const result = db.prepare(`INSERT OR IGNORE INTO meetings
    (id,source,title,meeting_date,owner_name,owner_email,prospect_name,prospect_company,recipient_email,meeting_url,crm_url,participants_json,source_payload_json,status,status_reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id, input.source || 'avoma', input.title || 'Untitled meeting', input.meetingDate || null,
      input.ownerName || null, input.ownerEmail || null, input.prospectName || null, input.prospectCompany || null,
      input.recipientEmail || null, input.meetingUrl || null, input.crmUrl || null, json(input.participants || []),
      json(input.raw || input), input.status || 'received', null, time, time
    );
  if (result.changes) audit(input.id, 'webhook_received', { source: input.source || 'avoma' });
  return { created: Boolean(result.changes), meeting: getMeeting(input.id) };
}

export function getMeeting(id) {
  const row = db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
  return row ? hydrateMeeting(row) : null;
}

export function updateMeeting(id, fields) {
  const allowed = ['status','status_reason','title','meeting_date','owner_name','owner_email','prospect_name','prospect_company','recipient_email','meeting_url','crm_url','participants_json','source_payload_json'];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return getMeeting(id);
  const sql = `UPDATE meetings SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=? WHERE id=?`;
  db.prepare(sql).run(...entries.map(([, value]) => value == null ? null : typeof value === 'object' ? json(value) : value), now(), id);
  return getMeeting(id);
}

export function createDraft(input) {
  const time = now();
  db.prepare(`INSERT INTO drafts (id,meeting_id,subject,body,recipient,cc_json,bcc_json,attachments_json,generation_json,review_token,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.meetingId, input.subject, input.body, input.recipient,
      json(input.cc || []), json(input.bcc || []), json(input.attachments || []), json(input.generation || {}), input.reviewToken, time, time);
  audit(input.meetingId, 'draft_created', { draftId: input.id, subject: input.subject });
  return getDraftByMeeting(input.meetingId);
}

export function updateDraft(meetingId, fields) {
  const map = { subject:'subject', body:'body', recipient:'recipient', cc:'cc_json', bcc:'bcc_json', attachments:'attachments_json', slackChannel:'slack_channel', slackTs:'slack_ts', approvedBy:'approved_by', sentAt:'sent_at', outlookMessageId:'outlook_message_id' };
  const entries = Object.entries(fields).filter(([key]) => map[key]);
  if (!entries.length) return getDraftByMeeting(meetingId);
  db.prepare(`UPDATE drafts SET ${entries.map(([key]) => `${map[key]}=?`).join(',')}, updated_at=? WHERE meeting_id=?`)
    .run(...entries.map(([key, value]) => ['cc','bcc','attachments'].includes(key) ? json(value) : value), now(), meetingId);
  return getDraftByMeeting(meetingId);
}

export function getDraftByMeeting(meetingId) {
  const row = db.prepare('SELECT * FROM drafts WHERE meeting_id=?').get(meetingId);
  return row ? hydrateDraft(row) : null;
}
export function getDraftByToken(token) {
  const row = db.prepare('SELECT * FROM drafts WHERE review_token=?').get(token);
  return row ? hydrateDraft(row) : null;
}
export function listMeetings(limit = 100) {
  return db.prepare(`SELECT m.*, d.subject, d.recipient AS draft_recipient, d.sent_at, d.slack_ts
    FROM meetings m LEFT JOIN drafts d ON d.meeting_id=m.id ORDER BY m.created_at DESC LIMIT ?`).all(limit).map(hydrateMeeting);
}
export function listAudit(meetingId = null, limit = 200) {
  const rows = meetingId ? db.prepare('SELECT * FROM audit_logs WHERE meeting_id=? ORDER BY id DESC LIMIT ?').all(meetingId, limit)
    : db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((row) => ({ ...row, details: parse(row.details_json, {}) }));
}

export function claimSend(meetingId, actor) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getMeeting(meetingId);
    if (!current || !['waiting_review','edited','send_failed'].includes(current.status)) throw new Error(`Draft cannot be sent from status: ${current?.status || 'missing'}`);
    updateMeeting(meetingId, { status: 'sending', status_reason: null });
    updateDraft(meetingId, { approvedBy: actor });
    audit(meetingId, 'send_approved', {}, actor);
    db.exec('COMMIT');
    return getMeeting(meetingId);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function hydrateMeeting(row) {
  return { ...row, participants: parse(row.participants_json, []), sourcePayload: parse(row.source_payload_json, {}) };
}
function hydrateDraft(row) {
  return { ...row, cc: parse(row.cc_json, []), bcc: parse(row.bcc_json, []), attachments: parse(row.attachments_json, []), generation: parse(row.generation_json, {}) };
}
