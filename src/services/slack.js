import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';

const slackClient = () => config.SLACK_BOT_TOKEN ? new WebClient(config.SLACK_BOT_TOKEN) : null;
const trim = (value, max = 2800) => String(value || '').slice(0, max);

export function verifySlackRequest(rawBody, timestamp, signature) {
  if (!config.SLACK_SIGNING_SECRET) return config.demoMode;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', config.SLACK_SIGNING_SECRET).update(base).digest('hex')}`;
  return safeEqual(expected, signature);
}

export async function postReview(meeting, draft) {
  const client = slackClient();
  if (!client || config.demoMode) return { channel: 'demo', ts: String(Date.now() / 1000) };
  let channel = config.aeSlackMap[meeting.owner_email] || config.SLACK_FALLBACK_CHANNEL;
  if (!channel) throw new Error(`No Slack destination is mapped for ${meeting.owner_email || 'the meeting owner'}`);
  if (channel.startsWith('U')) channel = (await client.conversations.open({ users: channel })).channel.id;
  const result = await client.chat.postMessage({ channel, text: `Follow-up draft for ${meeting.prospect_name || draft.recipient}`, blocks: reviewBlocks(meeting, draft) });
  return { channel: result.channel, ts: result.ts };
}

export async function updateReview(meeting, draft) {
  const client = slackClient();
  if (!client || config.demoMode || draft.slack_channel === 'demo') return;
  await client.chat.update({ channel: draft.slack_channel, ts: draft.slack_ts, text: `Follow-up: ${meeting.status}`, blocks: reviewBlocks(meeting, draft) });
}

export async function openEditModal(triggerId, meeting, draft) {
  const client = slackClient();
  if (!client) return;
  await client.views.open({ trigger_id: triggerId, view: {
    type: 'modal', callback_id: 'edit_draft', private_metadata: meeting.id,
    title: { type: 'plain_text', text: 'Review follow-up' },
    submit: { type: 'plain_text', text: 'Save changes' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input('recipient', 'Recipient', draft.recipient), input('cc', 'CC', draft.cc.join(', '), true), input('bcc', 'BCC', draft.bcc.join(', '), true),
      input('subject', 'Subject', draft.subject), input('body', 'Email body', draft.body, false, true),
      { type: 'input', optional: true, block_id: 'files', label: { type: 'plain_text', text: 'Attachments' }, element: { type: 'file_input', action_id: 'value', filetypes: ['pdf','doc','docx','ppt','pptx','xls','xlsx','png','jpg','jpeg','txt'], max_files: 5 } }
    ]
  }});
}

export async function downloadSlackFiles(fileIds = []) {
  const client = slackClient();
  if (!client || !fileIds.length) return [];
  const files = [];
  let total = 0;
  for (const id of fileIds) {
    const info = await client.files.info({ file: id });
    const file = info.file;
    if (!file?.url_private_download) continue;
    if (file.size > 3_000_000 || total + file.size > 8_000_000) throw new Error('Attachments must be under 3 MB each and 8 MB total');
    const response = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Could not download Slack file ${file.name}`);
    const buffer = Buffer.from(await response.arrayBuffer()); total += buffer.length;
    files.push({ name: file.name, contentType: file.mimetype, contentBytes: buffer.toString('base64') });
  }
  return files;
}

export function extractModalValues(view) {
  const get = (id) => view.state.values[id]?.value?.value || '';
  const files = view.state.values.files?.value?.files || [];
  return { recipient: get('recipient').trim(), cc: emails(get('cc')), bcc: emails(get('bcc')), subject: get('subject').trim(), body: get('body').trim(), fileIds: files.map((file) => file.id || file).filter(Boolean) };
}

export function reviewBlocks(meeting, draft) {
  const state = meeting.status.replaceAll('_', ' ');
  const isFinal = ['sent','cancelled','ignored'].includes(meeting.status);
  return [
    { type: 'header', text: { type: 'plain_text', text: `Follow-up · ${state}` } },
    { type: 'section', fields: [
      md(`*Prospect*\n${meeting.prospect_name || 'Not found'}`), md(`*Company*\n${meeting.prospect_company || 'Not found'}`),
      md(`*Meeting*\n${meeting.title}`), md(`*Date*\n${meeting.meeting_date ? new Date(meeting.meeting_date).toLocaleDateString() : 'Unknown'}`),
      md(`*To*\n${draft.recipient}`), md(`*Owner*\n${meeting.owner_name || meeting.owner_email || 'Unknown'}`)
    ] },
    { type: 'section', text: md(`*Subject*\n${trim(draft.subject, 500)}\n\n*Email*\n${trim(draft.body)}`) },
    ...(meeting.meeting_url || meeting.crm_url ? [{ type: 'context', elements: [meeting.meeting_url ? md(`<${meeting.meeting_url}|Open meeting>`) : null, meeting.crm_url ? md(`<${meeting.crm_url}|Open CRM>`) : null].filter(Boolean) }] : []),
    { type: 'actions', elements: isFinal ? [] : [
      button('Edit', 'edit_draft', meeting.id), button('Send email', 'send_email', meeting.id, 'primary'), button('Regenerate', 'regenerate', meeting.id), button('Cancel', 'cancel', meeting.id, 'danger')
    ] }
  ].filter((block) => block.type !== 'actions' || block.elements.length);
}

const md = (text) => ({ type: 'mrkdwn', text });
const button = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value, ...(style ? { style } : {}) });
const emails = (text) => text.split(',').map((v) => v.trim()).filter(Boolean);
function input(id, label, initialValue, optional = false, multiline = false) {
  return { type: 'input', block_id: id, optional, label: { type: 'plain_text', text: label }, element: { type: 'plain_text_input', action_id: 'value', initial_value: initialValue || '', ...(multiline ? { multiline: true } : {}) } };
}
