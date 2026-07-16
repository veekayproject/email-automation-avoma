import { config } from '../config.js';
import { db, audit } from '../db.js';
import { encrypt, decrypt, randomToken } from '../lib/crypto.js';

const scopes = ['openid','profile','email','offline_access','User.Read','Mail.Send'];
const tenantBase = () => `https://login.microsoftonline.com/${encodeURIComponent(config.MICROSOFT_TENANT_ID)}/oauth2/v2.0`;

export function createMicrosoftAuthUrl(aeEmail) {
  if (!config.MICROSOFT_CLIENT_ID) throw new Error('Microsoft integration is not configured');
  const state = randomToken();
  db.prepare('INSERT INTO oauth_states (state,ae_email,expires_at) VALUES (?,?,?)')
    .run(state, aeEmail.toLowerCase(), new Date(Date.now() + 10 * 60_000).toISOString());
  const params = new URLSearchParams({ client_id: config.MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: config.MICROSOFT_REDIRECT_URI, response_mode: 'query', scope: scopes.join(' '), state, prompt: 'select_account' });
  return `${tenantBase()}/authorize?${params}`;
}

export async function completeMicrosoftAuth(code, state) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state=?').get(state);
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
  if (!row || new Date(row.expires_at) < new Date()) throw new Error('Microsoft sign-in link expired; start again');
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.MICROSOFT_REDIRECT_URI });
  const profile = await graph('/me', tokens.access_token);
  const email = (profile.mail || profile.userPrincipalName || row.ae_email).toLowerCase();
  if (email !== row.ae_email.toLowerCase()) throw new Error(`Signed in as ${email}, but this connection is for ${row.ae_email}`);
  const time = new Date().toISOString();
  db.prepare(`INSERT INTO oauth_accounts (email,display_name,microsoft_user_id,refresh_token_encrypted,access_token_encrypted,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,microsoft_user_id=excluded.microsoft_user_id,
    refresh_token_encrypted=excluded.refresh_token_encrypted,access_token_encrypted=excluded.access_token_encrypted,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .run(email, profile.displayName, profile.id, encrypt(tokens.refresh_token), encrypt(tokens.access_token), new Date(Date.now() + tokens.expires_in * 1000).toISOString(), time, time);
  audit(null, 'microsoft_account_connected', { email }, email);
  return { email, displayName: profile.displayName };
}

export function listMicrosoftAccounts() {
  return db.prepare('SELECT email,display_name,expires_at,updated_at FROM oauth_accounts ORDER BY email').all();
}

async function accessTokenFor(email) {
  const row = db.prepare('SELECT * FROM oauth_accounts WHERE email=?').get(email.toLowerCase());
  if (!row) throw new Error(`No Microsoft account is connected for ${email}`);
  if (row.access_token_encrypted && new Date(row.expires_at).getTime() > Date.now() + 60_000) return decrypt(row.access_token_encrypted);
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_encrypted) });
  db.prepare('UPDATE oauth_accounts SET refresh_token_encrypted=?,access_token_encrypted=?,expires_at=?,updated_at=? WHERE email=?')
    .run(encrypt(tokens.refresh_token || decrypt(row.refresh_token_encrypted)), encrypt(tokens.access_token), new Date(Date.now() + tokens.expires_in * 1000).toISOString(), new Date().toISOString(), email.toLowerCase());
  return tokens.access_token;
}

export async function sendOutlookMail(meeting, draft) {
  if (config.demoMode) return { id: `demo-message-${Date.now()}` };
  const token = await accessTokenFor(meeting.owner_email);
  const toRecipients = addresses(draft.recipient);
  if (!toRecipients.length) throw new Error('A valid recipient is required');
  const message = {
    subject: draft.subject,
    body: { contentType: 'Text', content: draft.body },
    toRecipients, ccRecipients: addresses(draft.cc), bccRecipients: addresses(draft.bcc),
    attachments: (draft.attachments || []).map((file) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.contentType || 'application/octet-stream', contentBytes: file.contentBytes }))
  };
  await graph('/me/sendMail', token, { method: 'POST', body: JSON.stringify({ message, saveToSentItems: true }) });
  return { id: `graph-${Date.now()}` };
}

async function tokenRequest(values) {
  const body = new URLSearchParams({ client_id: config.MICROSOFT_CLIENT_ID, client_secret: config.MICROSOFT_CLIENT_SECRET, scope: scopes.join(' '), ...values });
  const response = await fetch(`${tenantBase()}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error_description || 'Microsoft token request failed');
  return result;
}
async function graph(path, token, init = {}) {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (response.status === 202 || response.status === 204) return {};
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Microsoft Graph request failed');
  return result;
}
const addresses = (input) => (Array.isArray(input) ? input : String(input || '').split(','))
  .map((email) => String(email).trim()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  .map((address) => ({ emailAddress: { address } }));
