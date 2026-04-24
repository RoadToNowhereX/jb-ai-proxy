const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

const DEFAULT_CONFIG = {
  port: 3000,
  api_key: '',
  panel_password: '',
  grazie_agent: {
    name: 'aia:idea',
    version: '261.22158.366:261.22158.277',
  },
  refresh_policy: {
    max_retries: 2,
    retry_delay_ms: 1500,
    auto_retry_on_error: true,
    auto_retry_types: ['network', 'server_error'],
  },
};

function mergeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    grazie_agent: {
      ...DEFAULT_CONFIG.grazie_agent,
      ...(input.grazie_agent || {}),
    },
    refresh_policy: {
      ...DEFAULT_CONFIG.refresh_policy,
      ...(input.refresh_policy || {}),
    },
  };
}

function loadConfig() {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  const normalized = mergeConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch {
    fs.writeFileSync(CREDENTIALS_PATH, '[]');
    return [];
  }
}

function saveCredentials(credentials) {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

module.exports = {
  loadConfig,
  saveConfig,
  loadCredentials,
  saveCredentials,
  CONFIG_PATH,
  CREDENTIALS_PATH,
  DEFAULT_CONFIG,
};
