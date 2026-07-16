import crypto from 'node:crypto';
import { config, applyRuntimeConfig, integrationStatus } from './config.js';
import { db, audit } from './db.js';
import { decrypt, encrypt } from './lib/crypto.js';

const noPricingTemplate = `Use this structure only when pricing was NOT explicitly discussed:
1. Personal greeting and brief thank-you.
2. Ask for the inputs needed for a custom demo: ideal target account criteria, important account signals, and 10-30 introducers with LinkedIn URLs.
3. State that after receiving the inputs, the team will configure 10-15 real-world connections.
4. Mention only attachments and resource links that are actually available in the meeting data.
5. Include the Avoma recording link when available.
6. Close by looking forward to the requested details. Never add pricing.`;

const pricingTemplate = `Use this structure only when pricing WAS explicitly discussed:
1. Personal greeting and brief thank-you.
2. Ask for the custom-demo inputs: ICP persona, ideal target account criteria, and the top 10 introducers with LinkedIn URLs.
3. State that after receiving the inputs, the team will configure 15-20 real-world connections.
4. Mention only attachments and resource links actually available in the meeting data.
5. Include the Avoma recording link when available.
6. Add the approved pricing and onboarding block exactly as configured below.
7. Close by looking forward to the details and the next conversation.`;

const approvedPricing = `Pricing details:
Vieu Core (Signal-Based Accounts Prioritization + Contextual Warm Intro Paths) - Unlimited Users
- Goal: Unlock strong connections via your combined network to your top priority accounts.
- Full Access: 1000 accounts at $12.5K/year.

Onboarding Plan:
- Week 1: Network mapping and graph building, plus target-account list configuration.
- Week 2: Custom signals, ICP refinement, and working sessions.
- Week 3 onward: Complete rollout, connection mining and pinning, and orchestration/refinement of connection paths.`;

const defaultFieldMap = JSON.stringify({ id:'data.meeting.id', title:'data.meeting.title', owner_email:'data.meeting.owner.email', owner_name:'data.meeting.owner.name', participants:'data.meeting.participants', summary:'data.meeting.summary', notes:'data.meeting.notes', transcript:'data.meeting.transcript', action_items:'data.meeting.action_items', meeting_url:'data.meeting.url', crm_url:'data.meeting.crm_url' }, null, 2);

export const settingDefinitions = {
  APP_BASE_URL: { label: 'Public app URL', default: 'http://localhost:3000' },
  ADMIN_PASSWORD: { label: 'Dashboard password', secret: true },
  DEMO_MODE: { label: 'Demo mode', default: 'true' },
  AVOMA_API_KEY: { label: 'Avoma API key', secret: true },
  AVOMA_API_BASE_URL: { label: 'Avoma API URL', default: 'https://api.avoma.com/v1' },
  AVOMA_WEBHOOK_SECRET: { label: 'Webhook secret', secret: true, generate: true },
  WEBHOOK_FIELD_MAP: { label: 'Webhook field map', default: defaultFieldMap },
  INTERNAL_DOMAINS: { label: 'Internal domains' },
  OPENAI_API_KEY: { label: 'OpenAI API key', secret: true },
  OPENAI_MODEL: { label: 'OpenAI model', default: 'gpt-5.6-luna' },
  SLACK_BOT_TOKEN: { label: 'Slack bot token', secret: true },
  SLACK_SIGNING_SECRET: { label: 'Slack signing secret', secret: true },
  SLACK_FALLBACK_CHANNEL: { label: 'Slack fallback channel' },
  AE_SLACK_MAP: { label: 'AE to Slack mapping', default: '{}' },
  MICROSOFT_CLIENT_ID: { label: 'Microsoft client ID' },
  MICROSOFT_CLIENT_SECRET: { label: 'Microsoft client secret', secret: true },
  MICROSOFT_TENANT_ID: { label: 'Microsoft tenant', default: 'common' },
  MICROSOFT_REDIRECT_URI: { label: 'Microsoft redirect URL', default: 'http://localhost:3000/auth/microsoft/callback' },
  EMAIL_TONE: { label: 'Email tone', default: 'warm, concise, specific, and professional' },
  EMAIL_MAX_WORDS: { label: 'Maximum words', default: '220' },
  EMAIL_TEMPLATE: { label: 'Email template guidance', default: 'Thank them briefly. Recap the most relevant needs and decisions. List clear next steps with owners. End with one natural call to action.' },
  EMAIL_TEMPLATE_PRICING: { label: 'Pricing-discussed template', default: pricingTemplate },
  EMAIL_TEMPLATE_NO_PRICING: { label: 'No-pricing template', default: noPricingTemplate },
  APPROVED_PRICING_TEXT: { label: 'Approved pricing text', default: approvedPricing },
  DEFAULT_CC: { label: 'Default CC' },
  HUBSPOT_ENABLED: { label: 'HubSpot logging', default: 'false' },
  HUBSPOT_ACCESS_TOKEN: { label: 'HubSpot access token', secret: true }
};

export function loadStoredSettings() {
  const stored = {};
  for (const row of db.prepare('SELECT key,value,is_secret FROM app_settings').all()) {
    try { stored[row.key] = row.is_secret ? decrypt(row.value) : row.value; } catch { /* Ignore values encrypted with an unavailable old key. */ }
  }
  for (const [key, definition] of Object.entries(settingDefinitions)) {
    if (stored[key] === undefined && definition.generate && !config[key]) stored[key] = crypto.randomBytes(24).toString('base64url');
    if (stored[key] === undefined && definition.default && !config[key]) stored[key] = definition.default;
  }
  applyRuntimeConfig(stored);
  if (stored.AVOMA_WEBHOOK_SECRET && !db.prepare('SELECT 1 FROM app_settings WHERE key=?').get('AVOMA_WEBHOOK_SECRET')) {
    saveSettings({ AVOMA_WEBHOOK_SECRET: stored.AVOMA_WEBHOOK_SECRET }, 'system');
  }
  return config;
}

export function saveSettings(input, actor = 'dashboard') {
  validateLiveConfiguration(input);
  const time = new Date().toISOString();
  const applied = {};
  const transaction = db.transaction ? db.transaction : null;
  for (const [key, rawValue] of Object.entries(input || {})) {
    const definition = settingDefinitions[key];
    if (!definition) continue;
    if (definition.secret && (rawValue === '' || rawValue === undefined || rawValue === null)) continue;
    let value = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue ?? '').trim();
    validate(key, value);
    db.prepare(`INSERT INTO app_settings (key,value,is_secret,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,is_secret=excluded.is_secret,updated_at=excluded.updated_at`)
      .run(key, definition.secret ? encrypt(value) : value, definition.secret ? 1 : 0, time);
    applied[key] = value;
  }
  applyRuntimeConfig(applied);
  audit(null, 'settings_updated', { fields: Object.keys(applied).filter((key) => !settingDefinitions[key]?.secret) }, actor);
  return publicSettings();
}

export function publicSettings() {
  const values = {};
  const configuredSecrets = {};
  for (const [key, definition] of Object.entries(settingDefinitions)) {
    if (definition.secret) configuredSecrets[key] = Boolean(config[key]);
    else values[key] = String(config[key] || definition.default || '');
  }
  return { values, configuredSecrets, integrations: integrationStatus(), accounts: [], webhookUrl: webhookUrl() };
}

export function webhookUrl() {
  const base = String(config.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/webhooks/avoma?secret=${encodeURIComponent(config.AVOMA_WEBHOOK_SECRET || '')}`;
}

function validate(key, value) {
  if (['APP_BASE_URL','AVOMA_API_BASE_URL','MICROSOFT_REDIRECT_URI'].includes(key)) {
    try { new URL(value); } catch { throw new Error(`${settingDefinitions[key].label} must be a valid URL`); }
  }
  if (key === 'EMAIL_MAX_WORDS' && (Number(value) < 50 || Number(value) > 800)) throw new Error('Maximum words must be between 50 and 800');
  if (['AE_SLACK_MAP','WEBHOOK_FIELD_MAP'].includes(key)) { try { JSON.parse(value || '{}'); } catch { throw new Error(`${settingDefinitions[key].label} must be valid JSON`); } }
}

function validateLiveConfiguration(input) {
  if (String(input?.DEMO_MODE ?? config.DEMO_MODE) !== 'false') return;
  const effective = (key) => input?.[key] || config[key];
  const required = [
    ['ADMIN_PASSWORD','dashboard password'], ['OPENAI_API_KEY','OpenAI API key'],
    ['SLACK_BOT_TOKEN','Slack bot token'], ['SLACK_SIGNING_SECRET','Slack signing secret'],
    ['MICROSOFT_CLIENT_ID','Microsoft client ID'], ['MICROSOFT_CLIENT_SECRET','Microsoft client secret'],
    ['INTERNAL_DOMAINS','internal company domain']
  ];
  const missing = required.filter(([key]) => !effective(key)).map(([, label]) => label);
  if (!String(effective('APP_BASE_URL') || '').startsWith('https://')) missing.push('public HTTPS app URL');
  if (missing.length) throw new Error(`Before enabling live mode, add: ${missing.join(', ')}`);
}

loadStoredSettings();
