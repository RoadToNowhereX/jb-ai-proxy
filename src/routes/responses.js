const express = require('express');
const modelId = require('../model-id');
const accountManager = require('../account-manager');
const jb = require('../jb-client');

const router = express.Router();

router.post('/v1/responses', async (req, res) => {
  try {
    const account = accountManager.getNext();
    if (!account) {
      return res.status(503).json({ error: { message: 'No active accounts', type: 'server_error' } });
    }

    const mapping = modelId.resolve(req.body.model, 'responses');
    if (!mapping || (mapping.family !== 'openai' && mapping.family !== 'xai')) {
      return res.status(400).json({
        error: {
          message: `Model "${req.body.model}" is not supported on /v1/responses. Use an OpenAI (gpt-*, o1-o4, *-codex) or xAI (grok-*) model, or call /v1/chat/completions or /v1/messages for other providers.`,
          type: 'invalid_request_error',
        },
      });
    }

    const jwt = await accountManager.ensureValidJwt(account);
    const call = mapping.family === 'xai' ? jb.nativeXaiResponses : jb.nativeOpenaiResponses;
    const body = { ...req.body, model: mapping.nativeId };
    const jbRes = await call(jwt, body);

    if (!jbRes.ok) {
      const errText = await jbRes.text();
      const status = jbRes.status === 477 ? 429 : jbRes.status;
      if (jbRes.status === 477) account.status = 'quota_exhausted';
      try {
        const parsed = JSON.parse(errText);
        if (parsed && parsed.error) {
          return res.status(status).json(parsed);
        }
      } catch {}
      return res.status(status).json({
        error: { message: errText, type: 'api_error' },
      });
    }

    const ct = jbRes.headers.get('content-type') || 'application/json';
    res.status(jbRes.status);
    res.setHeader('Content-Type', ct);
    if (ct.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }

    for await (const chunk of jbRes.body) {
      if (!res.write(chunk)) {
        await new Promise(resolve => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error('POST /v1/responses error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'server_error' } });
    }
  }
});

module.exports = router;
