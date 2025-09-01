// src/utils/config.js
const fs = require('fs');
const path = require('path');

// Load environment-specific .env file
const nodeEnv = process.env.NODE_ENV || 'production';
const envPath = path.join(process.cwd(), `.env.${nodeEnv}`);

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log(`[Config] Loaded environment file: .env.${nodeEnv}`);
} else {
  require('dotenv').config();
  console.log('[Config] Loaded default .env file');
}

function deepMerge(target, src){
  for (const [k, v] of Object.entries(src || {})){
    if (v && typeof v === 'object' && !Array.isArray(v)){
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else if (v !== undefined){
      target[k] = v;
    }
  }
  return target;
}

function readJsonSafe(p){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

const root = path.resolve(process.cwd());

// Load environment-specific config if it exists, otherwise fall back to main config
let configPath = path.join(root, 'config.json');
const envConfigPath = path.join(root, `config.${nodeEnv}.json`);

if (fs.existsSync(envConfigPath)) {
  configPath = envConfigPath;
  console.log(`[Config] Loading environment-specific config: ${envConfigPath}`);
} else {
  console.log(`[Config] Loading default config: ${configPath}`);
}

const jsonCfg = readJsonSafe(configPath);

const env = process.env;
const overlay = {
  web: { port: env.PORT ? Number(env.PORT) : undefined, publicBaseUrl: env.PUBLIC_BASE_URL },
  auth: {
    discord: {
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      scope: env.DISCORD_SCOPE,
      prompt: env.DISCORD_PROMPT
    },
    stateSecret: env.STATE_SECRET
  },
  billing: { paypal: { environment: env.PAYPAL_ENV, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID } }
};

const cfg = deepMerge(JSON.parse(JSON.stringify(jsonCfg)), overlay);

if (!cfg.web) cfg.web = {};
if (!cfg.web.publicBaseUrl && env.PUBLIC_URL) cfg.web.publicBaseUrl = env.PUBLIC_URL;

module.exports = cfg;
