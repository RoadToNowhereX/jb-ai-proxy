# JB AI Proxy

把 JetBrains AI 订阅转成 OpenAI、Anthropic、Responses 三种协议的反向代理。Claude / GPT / Grok 等模型直连 JB 官方的原生端点透传，保留 extended thinking、reasoning、prompt caching 等原生能力。

## 快速开始

```bash
npm install
node server.js
```

打开 `http://localhost:3000/panel` 添加账号（OAuth 登录或手动导入 refresh token），然后在任意 OpenAI / Anthropic 兼容客户端里：

- **Base URL**: `http://localhost:3000/v1`
- **API Key**: `config.json` 里的 `api_key`
- **Model**: JB profile ID（`anthropic-claude-4-7-opus`）或官方 ID（`claude-opus-4-7`）都可

## 三个端点

| 端点 | 协议 | 备注 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | GPT / o-系列原生透传；其他家族走聚合层 |
| `POST /v1/messages` | Anthropic | Claude 原生透传（含 thinking）；其他家族走聚合层 |
| `POST /v1/responses` | OpenAI Responses | GPT / Codex / Grok 原生透传；其他家族 400 |
| `GET /v1/models` | OpenAI | 返回当前账号可用的 JB profile |

`/v1/models` 会列出 50+ 模型，覆盖 Anthropic Claude 4-4.7 全系列、OpenAI GPT-4/4.1/5 + Codex + o 系列、Google Gemini 2.0-3.1、xAI Grok。具体以接口返回为准。

## 示例

### Claude + extended thinking

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "x-api-key: sk-your-key" -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-4-7-opus",
    "max_tokens": 8192,
    "thinking": {"type": "adaptive", "display": "summarized"},
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

响应里会有原生 `{"type": "thinking", "thinking": "...", "signature": "..."}` block 和完整 SSE 事件（`thinking_delta` / `signature_delta`）。

### GPT-5 + reasoning

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer sk-your-key" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "hi",
    "reasoning": {"effort": "high", "summary": "detailed"}
  }'
```

注意 Responses 协议的 token 上限字段是 `max_output_tokens`（不是 `max_tokens`）。

### 普通 chat

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" -H "Content-Type: application/json" \
  -d '{"model": "openai-gpt-5-4", "messages": [{"role": "user", "content": "hi"}]}'
```

## 配置

编辑 `config.json`（不存在会在首次启动时生成）：

```json
{
  "port": 3000,
  "api_key": "sk-your-key-here",
  "panel_password": "your-password",
  "grazie_agent": { "name": "aia:idea", "version": "261.22158.366:261.22158.277" }
}
```

`api_key` / `panel_password` 留空即不鉴权。

## 账号

凭据保存在 `credentials.json`，id_token 每 50 分钟、JWT 每 20 小时自动刷新，多账号轮询使用。License ID 在 [account.jetbrains.com/licenses](https://account.jetbrains.com/licenses) 查看。
