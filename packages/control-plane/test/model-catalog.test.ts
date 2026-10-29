import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_UNAVAILABLE_MESSAGE,
  MAX_CATALOG_PATTERNS,
  catalogAllowList,
  chooseModel,
  fetchModelCatalog,
  parseLiteLLMModelInfo,
  type InferenceTarget,
} from '../src/model-catalog.js';
import { codeOf } from './helpers/deps.js';

type Call = {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
};

function fakeFetch(...replies: Array<(url: string) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: (init as { redirect?: RequestRedirect } | undefined)?.redirect,
    });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const litellm: InferenceTarget = {
  baseUrl: 'https://litellm.internal',
  secret: 'sk-litellm', // notsecret
  header: 'authorization',
};
const anthropic: InferenceTarget = {
  baseUrl: 'https://api.anthropic.com',
  secret: 'sk-ant-api-x', // notsecret
  header: 'x-api-key',
};

// The hosts the tests' targets live on (R1): api.anthropic.com is always allow-listed.
const HOSTS = catalogAllowList(['litellm.internal']);

const INFO = {
  data: [
    {
      model_name: 'claude-opus-4-8',
      model_info: {
        mode: 'chat',
        max_input_tokens: 200000,
        max_output_tokens: 32000,
        supports_reasoning: true,
        supports_vision: true,
      },
    },
    // A second deployment of the same load-balanced model, with smaller limits: the smaller wins.
    {
      model_name: 'claude-opus-4-8',
      model_info: { mode: 'chat', max_input_tokens: 150000, max_output_tokens: 32000 },
    },
    { model_name: 'text-embedding-3', model_info: { mode: 'embedding' } },
    { model_name: 'granite-4.1-8b', model_info: {} },
    { model_name: 'has space', model_info: {} },
  ],
};

describe('parseLiteLLMModelInfo', () => {
  it('maps, filters non-chat and invalid names, and dedupes keeping the smaller limits', () => {
    expect(parseLiteLLMModelInfo(INFO).models).toEqual([
      {
        id: 'claude-opus-4-8',
        contextWindow: 150000,
        maxTokens: 32000,
        reasoning: true,
        vision: true,
      },
      { id: 'granite-4.1-8b' },
    ]);
  });

  it('keeps wildcard routes out of the list, as patterns (final review F8)', () => {
    const body = {
      data: [
        ...INFO.data,
        { model_name: 'anthropic/*', model_info: {} },
        { model_name: 'openai/gpt-*', model_info: { mode: 'chat' } },
        { model_name: 'embed/*', model_info: { mode: 'embedding' } },
      ],
    };
    const { models, patterns } = parseLiteLLMModelInfo(body);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'granite-4.1-8b']);
    expect(patterns).toEqual(['anthropic/*', 'openai/gpt-*']);
  });

  it('refuses a body with no data array', async () => {
    expect(await codeOf(() => parseLiteLLMModelInfo({ models: [] }))).toBe(
      'model_catalog_unavailable',
    );
  });
});

describe('fetchModelCatalog — LiteLLM', () => {
  it('calls /model/info with the credential as Bearer', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const { models } = await fetchModelCatalog(litellm, HOSTS, f);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'granite-4.1-8b']);
    expect(calls[0]!.url).toBe('https://litellm.internal/model/info');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-litellm');
  });

  it.each([
    ['https://litellm.internal/v1', 'https://litellm.internal/v1/model/info'],
    ['https://litellm.internal/', 'https://litellm.internal/model/info'],
    ['https://litellm.internal/v1/', 'https://litellm.internal/v1/model/info'],
  ])('joins %s without a doubled slash', async (baseUrl, expected) => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog({ ...litellm, baseUrl }, HOSTS, f);
    expect(calls[0]!.url).toBe(expected);
  });

  // R4: the shape /\/+$/ is quadratic on is a long run of slashes followed by a non-slash.
  it('joins after a long run of slashes followed by a non-slash in linear time', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const baseUrl = `https://litellm.internal${'/'.repeat(50_000)}x`;
    const started = Date.now();
    await fetchModelCatalog({ ...litellm, baseUrl }, HOSTS, f);
    expect(calls[0]!.url).toBe(`${baseUrl}/model/info`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('sends x-api-key when the binding says so', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog({ ...litellm, header: 'x-api-key' }, HOSTS, f);
    expect(calls[0]!.headers['x-api-key']).toBe('sk-litellm');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    ['a non-2xx', () => new Response('nope', { status: 404 })],
    ['a 200 HTML page', () => new Response('<html>login</html>', { status: 200 })],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('maps %s to model_catalog_unavailable without the secret in the message', async (_n, r) => {
    const { f } = fakeFetch(r);
    let message = '';
    const code = await codeOf(async () => {
      try {
        await fetchModelCatalog(litellm, HOSTS, f);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    });
    expect(code).toBe('model_catalog_unavailable');
    expect(message).not.toContain('sk-litellm');
  });

  it('tells the caller nothing of the upstream status; logs it with the host only (final review F2)', async () => {
    const { f } = fakeFetch(() => new Response('nope', { status: 403 }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let message = '';
    try {
      await fetchModelCatalog(
        { ...litellm, baseUrl: 'https://litellm.internal/v1?tenant=t1' },
        HOSTS,
        f,
      );
    } catch (e) {
      message = (e as Error).message;
    }
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    expect(message).toBe(CATALOG_UNAVAILABLE_MESSAGE);
    expect(message).not.toContain('403');
    expect(message).not.toContain('litellm.internal');
    expect(logged).toContain('litellm.internal');
    expect(logged).toContain('403');
    expect(logged).not.toContain('tenant=t1');
    expect(logged).not.toContain('/model/info');
    expect(logged).not.toContain('sk-litellm');
  });

  it('refuses a body over 4 MiB (final review F9)', async () => {
    const big = JSON.stringify({ data: [], pad: 'x'.repeat(4 * 1024 * 1024) });
    const { f } = fakeFetch(() => new Response(big, { status: 200 }));
    expect(await codeOf(() => fetchModelCatalog(litellm, HOSTS, f))).toBe(
      'model_catalog_unavailable',
    );
  });

  it('reads a body just under the cap', async () => {
    const body = JSON.stringify({ ...INFO, pad: 'x'.repeat(4 * 1024 * 1024 - 2000) });
    const { f } = fakeFetch(() => new Response(body, { status: 200 }));
    expect((await fetchModelCatalog(litellm, HOSTS, f)).models).toHaveLength(2);
  });

  it('times out a gateway that never answers', async () => {
    const hang = (async (_u: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await codeOf(() => fetchModelCatalog(litellm, HOSTS, hang, 20))).toBe(
      'model_catalog_unavailable',
    );
  });

  it('passes redirect: error to prevent cross-origin leaks of x-api-key', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog(litellm, HOSTS, f);
    for (const call of calls) {
      expect(call.redirect).toBe('error');
    }
  });
});

describe('fetchModelCatalog — Anthropic', () => {
  it('pages /v1/models with x-api-key and returns ids only', async () => {
    const { f, calls } = fakeFetch(
      json({ data: [{ id: 'claude-opus-4-8' }], has_more: true, last_id: 'claude-opus-4-8' }),
      json({ data: [{ id: 'claude-haiku-4-5' }], has_more: false, last_id: 'claude-haiku-4-5' }),
    );
    expect(await fetchModelCatalog(anthropic, HOSTS, f)).toEqual({
      models: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }],
      patterns: [],
    });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[1]!.url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-4-8',
    );
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-api-x');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('passes redirect: error on all pages to prevent cross-origin leaks of x-api-key', async () => {
    const { f, calls } = fakeFetch(
      json({ data: [{ id: 'claude-opus-4-8' }], has_more: true, last_id: 'claude-opus-4-8' }),
      json({ data: [{ id: 'claude-haiku-4-5' }], has_more: false, last_id: 'claude-haiku-4-5' }),
    );
    await fetchModelCatalog(anthropic, HOSTS, f);
    for (const call of calls) {
      expect(call.redirect).toBe('error');
    }
  });

  it('asks with the oauth beta header for an Anthropic OAuth token (#595)', async () => {
    // api.anthropic.com reads an OAuth token from Authorization: Bearer only with the
    // oauth beta header, which pi's client sends for its own Claude Pro logins.
    const { f, calls } = fakeFetch(json({ data: [{ id: 'claude-opus-4-8' }], has_more: false }));
    const oat: InferenceTarget = {
      baseUrl: 'https://api.anthropic.com',
      secret: 'sk-ant-oat01-not-real', // notsecret
      header: 'authorization',
    };
    await fetchModelCatalog(oat, HOSTS, f);
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-ant-oat01-not-real');
    expect(calls[0]!.headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
  });
});

describe('chooseModel', () => {
  it('returns the listed model with its limits, verified', async () => {
    const { f } = fakeFetch(json(INFO));
    expect(await chooseModel(litellm, 'claude-opus-4-8', 'litellm-prod', HOSTS, f)).toEqual({
      model: 'claude-opus-4-8',
      limits: { contextWindow: 150000, maxTokens: 32000, reasoning: true, vision: true },
      verified: true,
    });
  });

  it('returns a model without limits when the catalog entry has none', async () => {
    const { f } = fakeFetch(json(INFO));
    expect(await chooseModel(litellm, 'granite-4.1-8b', 'litellm-prod', HOSTS, f)).toEqual({
      model: 'granite-4.1-8b',
      verified: true,
    });
  });

  it('refuses an id the endpoint does not list, naming the credential and the id', async () => {
    const { f } = fakeFetch(json(INFO));
    let message = '';
    const code = await codeOf(async () => {
      try {
        await chooseModel(litellm, 'gpt-x', 'litellm-prod', HOSTS, f);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    });
    expect(code).toBe('model_unavailable');
    expect(message).toContain('gpt-x');
    expect(message).toContain('litellm-prod');
  });

  it('accepts the id unverified when the catalog cannot be read', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 502 }));
    expect(await chooseModel(litellm, 'gpt-x', 'litellm-prod', HOSTS, f)).toEqual({
      model: 'gpt-x',
      verified: false,
    });
  });

  describe('wildcard routes (final review F8)', () => {
    const WILD = {
      data: [...INFO.data, { model_name: 'anthropic/*', model_info: { max_input_tokens: 1 } }],
    };
    it('accepts an unlisted id a wildcard route matches, verified, without limits', async () => {
      const { f } = fakeFetch(json(WILD));
      expect(
        await chooseModel(litellm, 'anthropic/claude-opus-4-8', 'litellm-prod', HOSTS, f),
      ).toEqual({
        model: 'anthropic/claude-opus-4-8',
        verified: true,
      });
    });
    it.each(['openai/gpt-x', 'xanthropic/claude', 'anthropic'])(
      'still refuses %s, which no route matches as a whole string',
      async (id) => {
        const { f } = fakeFetch(json(WILD));
        expect(await codeOf(() => chooseModel(litellm, id, 'litellm-prod', HOSTS, f))).toBe(
          'model_unavailable',
        );
      },
    );
    it.each([
      ['a*b*c', 'axxbyyc', true],
      ['*', 'anything', true],
      ['a**b', 'ab', true],
      ['*suffix', 'has-suffix', true],
      ['prefix*', 'prefix', true],
      ['a*b*c', 'axxbyy', false],
      ['a*a', 'a', false],
    ])('matches %s against %s as a whole string: %s', async (pattern, id, ok) => {
      const body = { data: [{ model_name: pattern, model_info: {} }] };
      const { f } = fakeFetch(json(body));
      const run = () => chooseModel(litellm, id, 'litellm-prod', HOSTS, f);
      if (ok) expect((await run()).verified).toBe(true);
      else expect(await codeOf(run)).toBe('model_unavailable');
    });
    // The pattern comes from the credential's endpoint, which the user chooses: a backtracking
    // regex over it let one request block the control plane's event loop for minutes.
    it('refuses a many-star pattern against a 256-character id in linear time', async () => {
      const body = { data: [{ model_name: '*a*a*a*a*a*a*a*a*b', model_info: {} }] };
      const { f } = fakeFetch(json(body));
      const started = Date.now();
      expect(
        await codeOf(() => chooseModel(litellm, 'a'.repeat(256), 'litellm-prod', HOSTS, f)),
      ).toBe('model_unavailable');
      expect(Date.now() - started).toBeLessThan(500);
    });
    it('prefers the exact listing, with its limits', async () => {
      const body = { data: [...INFO.data, { model_name: '*', model_info: {} }] };
      const { f } = fakeFetch(json(body));
      expect(
        (await chooseModel(litellm, 'claude-opus-4-8', 'litellm-prod', HOSTS, f)).limits,
      ).toEqual({
        contextWindow: 150000,
        maxTokens: 32000,
        reasoning: true,
        vision: true,
      });
    });
  });
});

// PR #540 review R1: the catalog is asked only of an allow-listed host, and every failure reads the
// same to the caller -- the route is no oracle for the control plane's network.
describe('fetchModelCatalog — host allow-list and uniform failures (R1)', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('allow-lists api.anthropic.com, the default endpoint host, and the extra hosts', () => {
    expect([
      ...catalogAllowList(['LiteLLM.Internal', 'gw.example'], 'http://10.0.0.5:4000/v1'),
    ]).toEqual(['api.anthropic.com', 'litellm.internal', 'gw.example', '10.0.0.5']);
    expect([...catalogAllowList([])]).toEqual(['api.anthropic.com']);
  });

  it('fetches from the default endpoint host', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const hosts = catalogAllowList([], 'http://10.0.0.5:4000');
    await fetchModelCatalog({ ...litellm, baseUrl: 'http://10.0.0.5:4000' }, hosts, f);
    expect(calls[0]!.url).toBe('http://10.0.0.5:4000/model/info');
  });

  it('does not contact a host outside the allow-list, and logs why', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const log = quiet();
    let message = '';
    const code = await codeOf(async () => {
      try {
        await fetchModelCatalog({ ...litellm, baseUrl: 'http://10.0.0.7:6379/x?q=1' }, HOSTS, f);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    });
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    expect(code).toBe('model_catalog_unavailable');
    expect(message).toBe(CATALOG_UNAVAILABLE_MESSAGE);
    expect(calls).toHaveLength(0);
    expect(logged).toContain('10.0.0.7');
    expect(logged).toContain('not in the catalog allow-list (SH_MODEL_CATALOG_HOSTS)');
    expect(logged).not.toContain('q=1');
  });

  it('accepts the id unverified on an unlisted host, without a fetch', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const log = quiet();
    const other = { ...litellm, baseUrl: 'https://elsewhere.example' };
    expect(await chooseModel(other, 'gpt-x', 'litellm-prod', HOSTS, f)).toEqual({
      model: 'gpt-x',
      verified: false,
    });
    log.mockRestore();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['not allow-listed', 'https://elsewhere.example', () => new Response('{}')],
    ['a non-2xx', 'https://litellm.internal', () => new Response('nope', { status: 404 })],
    [
      'no answer',
      'https://litellm.internal',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['not JSON', 'https://litellm.internal', () => new Response('<html>', { status: 200 })],
    ['no data list', 'https://litellm.internal', json({ models: [] })],
    [
      'too large',
      'https://litellm.internal',
      () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 }),
    ],
  ])('says the same thing to the caller for %s', async (_kind, baseUrl, reply) => {
    const { f } = fakeFetch(reply as (url: string) => Response);
    const log = quiet();
    let err: { code?: string; message?: string } = {};
    try {
      await fetchModelCatalog({ ...litellm, baseUrl }, HOSTS, f);
    } catch (e) {
      err = e as typeof err;
    }
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    expect(err.code).toBe('model_catalog_unavailable');
    expect(err.message).toBe(CATALOG_UNAVAILABLE_MESSAGE);
    expect(logged).toContain(new URL(baseUrl).hostname);
    expect(logged).not.toContain('sk-litellm');
  });

  it('cancels the body of a non-2xx before failing', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const { f } = fakeFetch(() => new Response(body, { status: 500 }));
    const log = quiet();
    await codeOf(() => fetchModelCatalog(litellm, HOSTS, f));
    log.mockRestore();
    expect(cancelled).toBe(true);
  });

  it.each([
    ['https://litellm.internal/admin?', 'https://litellm.internal/admin/model/info'],
    ['https://litellm.internal/v1?tenant=t1', 'https://litellm.internal/v1/model/info'],
    ['https://litellm.internal/v1#frag', 'https://litellm.internal/v1/model/info'],
    ['https://litellm.internal/#', 'https://litellm.internal/model/info'],
  ])('ignores the query and fragment of %s', async (baseUrl, expected) => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog({ ...litellm, baseUrl }, HOSTS, f);
    expect(calls[0]!.url).toBe(expected);
  });

  it('ignores the query and fragment of an Anthropic endpoint too', async () => {
    const { f, calls } = fakeFetch(json({ data: [], has_more: false }));
    await fetchModelCatalog(
      { ...anthropic, baseUrl: 'https://api.anthropic.com/?x=1#y' },
      HOSTS,
      f,
    );
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
  });
});

// PR #540 review R7: only the 4 MiB body cap once bounded the number of wildcard routes.
describe('parseLiteLLMModelInfo — wildcard route cap (R7)', () => {
  it(`keeps ${MAX_CATALOG_PATTERNS} wildcard routes and logs the dropped rest once`, () => {
    const data = Array.from({ length: MAX_CATALOG_PATTERNS + 10 }, (_, i) => ({
      model_name: `p${i}/*`,
      model_info: {},
    }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { patterns } = parseLiteLLMModelInfo({ data });
    const lines = log.mock.calls.length;
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    expect(patterns).toHaveLength(MAX_CATALOG_PATTERNS);
    expect(patterns[0]).toBe('p0/*');
    expect(lines).toBe(1);
    expect(logged).toContain('dropped 10');
  });
});
