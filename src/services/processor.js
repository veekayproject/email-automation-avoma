import crypto from 'node:crypto';
import { config } from '../config.js';
import { audit, claimSend, createDraft, createMeeting, getDraftByMeeting, getMeeting, updateDraft, updateMeeting } from '../db.js';
import { randomToken } from '../lib/crypto.js';
import { enrichFromAvoma, meetingEligibility, normalizeWebhook } from './meeting.js';
import { generateEmail } from './generator.js';
import { postReview, updateReview } from './slack.js';
import { sendOutlookMail } from './microsoft.js';
import { logSentEmailToHubSpot } from './hubspot.js';

export async function acceptWebhook(payload) {
  let meeting = normalizeWebhook(payload);
  if (!meeting.id) throw new Error('Webhook payload must include a meeting ID');
  const inserted = createMeeting(meeting);
  if (!inserted.created) return { duplicate: true, meeting: inserted.meeting };
  queueMicrotask(() => processMeeting(meeting.id).catch((error) => fail(meeting.id, 'processing_failed', error)));
  return { duplicate: false, meeting: inserted.meeting };
}

export async function processMeeting(meetingId, options = {}) {
  let stored = getMeeting(meetingId);
  if (!stored) throw new Error('Meeting not found');
  updateMeeting(meetingId, { status: 'processing', status_reason: null });
  const normalized = normalizeWebhook(stored.sourcePayload);
  const meeting = await enrichFromAvoma({ ...normalized, id: meetingId });
  const eligibility = meetingEligibility(meeting);
  updateMeeting(meetingId, {
    title: meeting.title, meeting_date: meeting.meetingDate, owner_name: meeting.ownerName, owner_email: meeting.ownerEmail,
    prospect_name: meeting.prospectName, prospect_company: meeting.prospectCompany, recipient_email: meeting.recipientEmail,
    meeting_url: meeting.meetingUrl, crm_url: meeting.crmUrl, participants_json: meeting.participants, source_payload_json: meeting.raw
  });
  if (!eligibility.eligible) {
    updateMeeting(meetingId, { status: 'ignored', status_reason: eligibility.reason });
    audit(meetingId, 'meeting_ignored', { reason: eligibility.reason });
    return getMeeting(meetingId);
  }
  if (getDraftByMeeting(meetingId) && !options.regenerate) return getMeeting(meetingId);
  const generated = await generateEmail(meeting);
  let draft = getDraftByMeeting(meetingId);
  if (draft) {
    draft = updateDraft(meetingId, { subject: generated.subject, body: generated.body });
    audit(meetingId, 'draft_regenerated', { model: generated.model });
  } else {
    draft = createDraft({ id: crypto.randomUUID(), meetingId, subject: generated.subject, body: generated.body,
      recipient: meeting.recipientEmail, cc: config.defaultCc, reviewToken: randomToken(), generation: generated });
  }
  updateMeeting(meetingId, { status: 'draft_created' });
  const slack = await postReview(getMeeting(meetingId), draft);
  draft = updateDraft(meetingId, { slackChannel: slack.channel, slackTs: slack.ts });
  updateMeeting(meetingId, { status: 'waiting_review' });
  audit(meetingId, 'review_requested', { slackChannel: slack.channel });
  return getMeeting(meetingId);
}

export async function editDraft(meetingId, changes, actor = 'slack') {
  const meeting = getMeeting(meetingId);
  if (!meeting || ['sent','cancelled'].includes(meeting.status)) throw new Error('This draft can no longer be edited');
  const draft = updateDraft(meetingId, changes);
  updateMeeting(meetingId, { status: 'edited' });
  audit(meetingId, 'draft_edited', { fields: Object.keys(changes).filter((k) => k !== 'attachments') }, actor);
  await updateReview(getMeeting(meetingId), draft);
  return draft;
}

export async function approveAndSend(meetingId, actor) {
  claimSend(meetingId, actor);
  const meeting = getMeeting(meetingId); const draft = getDraftByMeeting(meetingId);
  try {
    const sent = await sendOutlookMail(meeting, draft);
    const sentAt = new Date().toISOString();
    updateDraft(meetingId, { sentAt, outlookMessageId: sent.id });
    updateMeeting(meetingId, { status: 'sent', status_reason: null });
    audit(meetingId, 'email_sent', { recipient: draft.recipient, subject: draft.subject, outlookMessageId: sent.id }, actor);
    try {
      const hubspot = await logSentEmailToHubSpot(getMeeting(meetingId), draft, sentAt);
      if (!hubspot.skipped) audit(meetingId, 'hubspot_email_logged', { hubspotEmailId: hubspot.id });
      else if (hubspot.reason) audit(meetingId, 'hubspot_logging_skipped', { reason: hubspot.reason });
    } catch (hubspotError) {
      audit(meetingId, 'hubspot_logging_failed', { error: hubspotError.message });
    }
    await updateReview(getMeeting(meetingId), getDraftByMeeting(meetingId));
    return getMeeting(meetingId);
  } catch (error) {
    updateMeeting(meetingId, { status: 'send_failed', status_reason: error.message });
    audit(meetingId, 'email_send_failed', { error: error.message }, actor);
    await updateReview(getMeeting(meetingId), draft).catch(() => {});
    throw error;
  }
}

export async function cancelMeeting(meetingId, actor) {
  const meeting = getMeeting(meetingId); if (!meeting || meeting.status === 'sent') throw new Error('Sent email cannot be cancelled');
  updateMeeting(meetingId, { status: 'cancelled', status_reason: `Cancelled by ${actor}` });
  audit(meetingId, 'draft_cancelled', {}, actor);
  const draft = getDraftByMeeting(meetingId); if (draft) await updateReview(getMeeting(meetingId), draft);
}

export async function createSlackTestReview(meetingInput, draftInput, actor = 'dashboard-test') {
  const meetingId = `test-${crypto.randomUUID()}`;
  const meeting = { ...meetingInput, id: meetingId, source: 'test-lab', title: `[TEST] ${meetingInput.title || 'Follow-up review'}`, raw: { test: true, normalized: meetingInput } };
  createMeeting(meeting);
  const draft = createDraft({ id: crypto.randomUUID(), meetingId, subject: draftInput.subject, body: draftInput.body,
    recipient: draftInput.recipient, cc: draftInput.cc || [], bcc: draftInput.bcc || [], reviewToken: randomToken(),
    generation: { model: config.OPENAI_MODEL, template_type: draftInput.template_type, test: true } });
  updateMeeting(meetingId, { status: 'draft_created' });
  const slack = await postReview(getMeeting(meetingId), draft);
  updateDraft(meetingId, { slackChannel: slack.channel, slackTs: slack.ts });
  updateMeeting(meetingId, { status: 'waiting_review', status_reason: 'Test Lab draft - review and edit before sending' });
  audit(meetingId, 'test_review_created', { slackChannel: slack.channel }, actor);
  return { meeting: getMeeting(meetingId), draft: getDraftByMeeting(meetingId) };
}

function fail(meetingId, event, error) {
  updateMeeting(meetingId, { status: 'failed', status_reason: error.message });
  audit(meetingId, event, { error: error.message });
}
