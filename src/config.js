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
  grazie_agents: [
    { name: 'aia:idea', version: '261.22158.366:261.22158.277' },
    { name: 'aia:clion', version: '261.24374.148:261.24374.208' },
    { name: 'aia:rider', version: '261.24374.190:261.24374.190' },
    { name: 'aia:pycharm', version: '2261.22158.340:261.22158.366' },
  ],
  refresh_policy: {
    max_retries: 2,
    retry_delay_ms: 1500,
    auto_retry_on_error: true,
    auto_retry_types: ['network', 'server_error'],
  },
  quota_refresh_interval: 60,
  quota_min_remaining_percent: 10,
  polling: {
    time_weight: 0.3,
    horizon_days: 30,
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
    grazie_agents: input.grazie_agents || DEFAULT_CONFIG.grazie_agents,
    refresh_policy: {
      ...DEFAULT_CONFIG.refresh_policy,
      ...(input.refresh_policy || {}),
    },
    quota_refresh_interval: input.quota_refresh_interval ?? DEFAULT_CONFIG.quota_refresh_interval,
    quota_min_remaining_percent: input.quota_min_remaining_percent ?? DEFAULT_CONFIG.quota_min_remaining_percent,
    polling: {
      ...DEFAULT_CONFIG.polling,
      ...(input.polling || {}),
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
