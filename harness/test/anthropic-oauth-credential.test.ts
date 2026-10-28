import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { complete, getModel } from '@earendil-works/pi-ai';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyModelGateway, oauthAuthStorage } from '../src/run-turn';

/**
 * A caller credential that is an Anthropic OAuth token (#595): the harness must hand it to pi as
 * the API key pi itself resolves, because pi-ai enables its OAuth wire shape (Authorization: Bearer
 * + the oauth beta header + the Claude Code identity) only for a key it resolved from authStorage —
 * never for a token routed through model.headers.
 */
const OAT = 'sk-ant-oat01-not-a-real-token'; // notsecret

describe('oauthAuthStorage', () => {
  const model = getModel('anthropic', 'claude-haiku-4-5');

  it('hands an Anthropic OAuth token to pi as the key its registry resolves', async () => {
    const storage = oauthAuthStorage(model, {
      upstreamCredential: { mode: 'direct', value: OAT },
    });
    expect(storage).toBeDefined();
    // What createAgentSession's ModelRegistry will resolve for the turn's requests.
    const auth = await ModelRegistry.inMemory(storage!).getApiKeyAndHeaders(model);
    expect(auth.ok).toBe(true);
    expect((auth as { apiKey?: string }).apiKey).toBe(OAT);
  });

  it('keys the override on the model provider pi resolves the key by', async () => {
    const storage = oauthAuthStorage(model, {
      upstreamCredential: { mode: 'direct', value: OAT },
    });
    expect(await storage!.getApiKey('anthropic')).toBe(OAT);
    expect(await storage!.getApiKey('openai')).toBeUndefined();
  });

  it('returns undefined for every credential that is not an Anthropic OAuth token on Bearer', () => {
    expect(oauthAuthStorage(model)).toBeUndefined();
    expect(oauthAuthStorage(model, {})).toBeUndefined();
    // A gateway token and a raw key keep today's model.headers path.
    expect(
      oauthAuthStorage(model, { upstreamCredential: { mode: 'direct', value: 'gw-token' } }),
    ).toBeUndefined();
    expect(
      oauthAuthStorage(model, {
        upstreamCredential: { mode: 'direct', value: 'sk-ant-api03-x', header: 'x-api-key' },
      }),
    ).toBeUndefined();
    // The x-api-key binding cannot carry an OAuth token (the control plane refuses it at PUT).
    expect(
      oauthAuthStorage(model, {
        upstreamCredential: { mode: 'direct', value: OAT, header: 'x-api-key' },
      }),
    ).toBeUndefined();
    // A placeholder never reaches upstream as itself.
    expect(
      oauthAuthStorage(model, {
        upstreamCredential: { mode: 'placeholder', value: 'sh-placeholder-github:1234' },
      }),
    ).toBeUndefined();
  });
});

describe('an Anthropic OAuth token on the wire', () => {
  let server: Server;
  let seen: IncomingHttpHeaders | undefined;
  let baseUrl: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    seen = undefined;
    server = createServer((req, res) => {
      seen = req.headers;
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid oauth token' },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('goes as Authorization: Bearer with the oauth beta header, which only the resolved key gets', async () => {
    const model = applyModelGateway(getModel('anthropic', 'claude-haiku-4-5'), {
      anthropicBaseUrl: baseUrl,
      upstreamCredential: { mode: 'direct', value: OAT },
    });
    // Exactly what executeTurnCore now passes createAgentSession: the OAuth token resolved as pi's
    // own API key, plus the model headers applyModelGateway layered on top of it.
    const storage = oauthAuthStorage(model, {
      upstreamCredential: { mode: 'direct', value: OAT },
    });
    const auth = await ModelRegistry.inMemory(storage!).getApiKeyAndHeaders(model);
    await complete(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, {
      apiKey: (auth as { apiKey: string }).apiKey,
      headers: (auth as { headers?: Record<string, string> }).headers,
    } as never);

    expect(seen).toBeDefined();
    expect(seen!.authorization).toBe(`Bearer ${OAT}`);
    expect(seen!['x-api-key']).toBeUndefined();
    // api.anthropic.com reads an OAuth token only with the oauth beta header; pi adds it (plus the
    // Claude Code identity betas) when its resolved key is the token.
    expect(String(seen!['anthropic-beta'])).toContain('oauth-2025-04-20');
  });
});
