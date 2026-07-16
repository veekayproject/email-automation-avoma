import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADMIN_PASSWORD: z.string().default(''),
  APP_ENCRYPTION_KEY: z.string().default(''),
  DATABASE_PATH: z.string().default('./data/followpilot.db'),
  DEMO_MODE: z.string().default('true'),
  AVOMA_API_KEY: z.string().default(''),
  AVOMA_API_BASE_URL: z.string().url().default('https://api.avoma.com/v1'),
  AVOMA_WEBHOOK_SECRET: z.string().default(''),
  WEBHOOK_FIELD_MAP: z.string().default(''),
  INTERNAL_DOMAINS: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_SIGNING_SECRET: z.string().default(''),
  SLACK_FALLBACK_CHANNEL: z.string().default(''),
  AE_SLACK_MAP: z.string().default('{}'),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_REDIRECT_URI: z.string().default('http://localhost:3000/auth/microsoft/callback'),
  EMAIL_TONE: z.string().default('warm, concise, specific, and professional'),
  EMAIL_MAX_WORDS: z.coerce.number().min(50).max(800).default(220),
  EMAIL_TEMPLATE: z.string().default('Thank them briefly. Recap the most relevant needs and decisions. List clear next steps with owners. End with one natural call to action.'),
  EMAIL_TEMPLATE_PRICING: z.string().default(''),
  EMAIL_TEMPLATE_NO_PRICING: z.string().default(''),
  APPROVED_PRICING_TEXT: z.string().default(''),
  DEFAULT_CC: z.string().default(''),
  HUBSPOT_ENABLED: z.string().default('false'),
  HUBSPOT_ACCESS_TOKEN: z.string().default(''),
  HUBSPOT_API_BASE_URL: z.string().url().default('https://api.hubapi.com')
});

const raw = envSchema.parse(process.env);
const parseJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export const config = {
  ...raw,
  demoMode: raw.DEMO_MODE === 'true',
  hubspotEnabled: raw.HUBSPOT_ENABLED === 'true',
  internalDomains: raw.INTERNAL_DOMAINS.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
  defaultCc: raw.DEFAULT_CC.split(',').map((v) => v.trim()).filter(Boolean),
  aeSlackMap: parseJson(raw.AE_SLACK_MAP, {})
};

export function applyRuntimeConfig(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && key in config) config[key] = value;
  }
  config.demoMode = String(config.DEMO_MODE) === 'true';
  config.hubspotEnabled = String(config.HUBSPOT_ENABLED) === 'true';
  config.internalDomains = String(config.INTERNAL_DOMAINS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  config.defaultCc = String(config.DEFAULT_CC || '').split(',').map((v) => v.trim()).filter(Boolean);
  config.aeSlackMap = parseJson(String(config.AE_SLACK_MAP || '{}'), {});
  config.webhookFieldMap = parseJson(String(config.WEBHOOK_FIELD_MAP || '{}'), {});
  config.EMAIL_MAX_WORDS = Number(config.EMAIL_MAX_WORDS) || 220;
  return config;
}

export const integrationStatus = () => ({
  avoma: Boolean(config.AVOMA_API_KEY),
  openai: Boolean(config.OPENAI_API_KEY),
  slack: Boolean(config.SLACK_BOT_TOKEN && config.SLACK_SIGNING_SECRET),
  microsoft: Boolean(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET),
  hubspot: Boolean(config.HUBSPOT_ACCESS_TOKEN),
  demoMode: config.demoMode
});
