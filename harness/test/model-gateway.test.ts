import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyModelGateway } from '../src/run-turn';
import { AMBIENT_KEY_SENTINEL } from '../src/ambient-sentinel';

const baseModel = { id: 'claude-haiku-4-5', headers: { 'x-api-key': 'orig' } } as never;

describe('applyModelGateway', () => {
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let savedTok: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    savedTok = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
    if (savedTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
  });

  it('returns the base model unchanged when no gateway base or token is set', () => {
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m).toBe(baseModel);
  });

  it('applies the gateway baseUrl and Bearer auth, stripping x-api-key', () => {
    const m = applyModelGateway(baseModel, {
      anthropicBaseUrl: 'https://gw.example/v1',
      anthropicAuthToken: 'tok-123',
    }) as any;
    expect(m.baseUrl).toBe('https://gw.example/v1');
    expect(m.headers.Authorization).toBe('Bearer tok-123');
    expect(m.headers['x-api-key']).toBeNull();
  });

  it('reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from env when config omits them', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env-gw/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-tok';
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m.baseUrl).toBe('https://env-gw/v1');
    expect(m.headers.Authorization).toBe('Bearer env-tok');
  });

  it('seeds only the constant sentinel, never the auth token, when the key is unset', () => {
    applyModelGateway(baseModel, { anthropicAuthToken: 'tok-xyz' }); // notsecret
    expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    expect(process.env.ANTHROPIC_API_KEY).not.toBe('tok-xyz');
  });

  it('disables gateway-incompatible compat flags when a gateway base is set', () => {
    // litellm rejects per-tool eager_input_streaming / cache_control; the gateway model must
    // disable these so convertTools() omits them (otherwise tool-bearing requests 400).
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://gw.example/v1' }) as any;
    expect(m.compat.supportsEagerToolInputStreaming).toBe(false);
    expect(m.compat.supportsCacheControlOnTools).toBe(false);
    expect(m.compat.supportsLongCacheRetention).toBe(false);
  });

  it('does not add compat when no gateway base is set (direct API)', () => {
    const m = applyModelGateway(baseModel, { anthropicAuthToken: 'tok-only' }) as any;
    expect(m.compat).toBeUndefined();
  });

  it('applies baseUrl + disables compat but sets no auth header for a token-less public gateway', () => {
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://public-gw/v1' }) as any;
    expect(m.baseUrl).toBe('https://public-gw/v1');
    expect(m.compat.supportsEagerToolInputStreaming).toBe(false);
    // no token → no Authorization header, and the original headers are left untouched
    expect(m.headers.Authorization).toBeUndefined();
    expect(m.headers['x-api-key']).toBe('orig');
  });

  it('treats an empty-string config value as unset and falls back to the env var', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env-gw/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-tok';
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: '', anthropicAuthToken: '' }) as any;
    expect(m.baseUrl).toBe('https://env-gw/v1');
    expect(m.headers.Authorization).toBe('Bearer env-tok');
  });

  describe('an Anthropic OAuth token (#595)', () => {
    const OAT = 'sk-ant-oat01-not-real'; // notsecret
    const oatConfig = {
      anthropicBaseUrl: 'https://api.anthropic.com',
      upstreamCredential: { mode: 'direct' as const, value: OAT },
    };

    it("adds no anthropic-beta of its own: pi's OAuth defaults govern", () => {
      // pi's client computes claude-code-20250219,oauth-2025-04-20 + its per-request betas when its
      // resolved key is the token; a header here would REPLACE that list wholesale.
      const m = applyModelGateway(baseModel, oatConfig) as any;
      expect(m.headers.Authorization).toBe(`Bearer ${OAT}`);
      expect(m.headers['anthropic-beta']).toBeUndefined();
    });

    it('appends the oauth beta to a model that carries its own anthropic-beta', () => {
      // mergeHeaders is a plain Object.assign, so a model-level anthropic-beta replaces pi's OAuth
      // betas entirely; without oauth-2025-04-20 the token 401s (PR #658 review). Keep the model's
      // betas, add the one the token needs.
      const custom = {
        id: 'claude-haiku-4-5',
        headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
      } as never;
      const m = applyModelGateway(custom, oatConfig) as any;
      expect(m.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14,oauth-2025-04-20');
    });

    it('leaves a model beta list that already carries the oauth beta alone', () => {
      const custom = {
        id: 'claude-haiku-4-5',
        headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      } as never;
      const m = applyModelGateway(custom, oatConfig) as any;
      expect(m.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    });

    it('does not touch anthropic-beta for a non-OAuth token', () => {
      const custom = {
        id: 'claude-haiku-4-5',
        headers: { 'anthropic-beta': 'custom-beta' },
      } as never;
      const m = applyModelGateway(custom, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct' as const, value: 'gw-token' }, // notsecret
      }) as any;
      expect(m.headers['anthropic-beta']).toBe('custom-beta');
    });
  });

  describe('a tagged upstream credential (MU1 spec §3.6)', () => {
    it('takes precedence over both anthropicAuthToken and the environment', () => {
      // MU1's work is to make `config` carry the RIGHT SUBJECT's token; the gateway function itself
      // needs no new logic (spec §3.4).
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-deployment-token'; // notsecret
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        anthropicAuthToken: 'stale-config-token', // notsecret
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-alice'); // notsecret
    });

    it('installs a placeholder verbatim, for an injector to rewrite', () => {
      // RC1's static-inject rewrites `Bearer <placeholder>` from a mounted secret_dir (P5 §3.1-§3.2),
      // so the harness must send it through UNCHANGED rather than treating it as a real token.
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'placeholder', value: 'sh-placeholder-github:1234' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sh-placeholder-github:1234'); // notsecret
    });

    it('falls back to the existing chain when no upstream credential is supplied', () => {
      // The whole point of an ADDITIVE change: every existing caller -- the leaf path, the CLI, the 14
      // unauthenticated deploy scripts -- must behave exactly as before.
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'; // notsecret
      const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://gw.example/v1' }) as any;
      expect(m.headers.Authorization).toBe('Bearer env-token'); // notsecret
    });

    it('treats an empty value as "not set", like every other term in the chain', () => {
      // `||` not `??` throughout this function: "" is a not-set sentinel here, not a credential.
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'; // notsecret
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: '' },
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer env-token'); // notsecret
    });

    it("never writes the subject's own credential into the environment (MI1 R2)", () => {
      // In a fresh process with no ANTHROPIC_API_KEY, an authenticated turn's credential travels
      // only in its own request's Bearer header; the environment only ever receives a constant
      // that names no one.
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-alice'); // notsecret
      expect(m.headers['x-api-key']).toBeNull();
      expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    });

    it('a token-less call after an authenticated one inherits nothing from it', () => {
      applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      });
      const second = applyModelGateway(baseModel, {}) as any;
      expect(second).toBe(baseModel); // no gateway, no token: the model is returned unchanged
      expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
      expect(JSON.stringify(process.env)).not.toContain('sk-alice');
    });

    it('does NOT overwrite an ANTHROPIC_API_KEY that is already set — the seed is write-once', () => {
      // The other half of the same property, and the half that keeps the seed from being a
      // cross-subject leak on every turn: with the deployment's key already in the environment (the
      // normal case, per service.yaml's required secretKeyRef) Alice's credential does not replace it.
      process.env.ANTHROPIC_API_KEY = 'sk-deployment'; // notsecret
      applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-deployment'); // notsecret
    });
  });

  describe('which models carry a caller credential (PR #350 review)', () => {
    const caller = { upstreamCredential: { mode: 'direct' as const, value: 'sk-caller' } }; // notsecret

    it("applies it to an explicit 'anthropic-messages' model", () => {
      const m = applyModelGateway(
        { id: 'claude', api: 'anthropic-messages', headers: { 'x-api-key': 'orig' } } as never,
        caller,
      ) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-caller'); // notsecret
      expect(m.headers['x-api-key']).toBeNull();
    });

    it('applies it to a model with no api field: absent means anthropic-messages, deliberately', () => {
      const m = applyModelGateway(baseModel, caller) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-caller'); // notsecret
    });
  });

  describe('a non-Anthropic model (PR #350 review)', () => {
    const openaiModel = { id: 'gpt-x', api: 'openai-completions', headers: {} } as never;

    it('refuses a per-caller credential rather than dropping it for the shared one', () => {
      expect(() =>
        applyModelGateway(openaiModel, {
          upstreamCredential: { mode: 'direct', value: 'sk-caller' }, // notsecret
        }),
      ).toThrow(/per-caller upstream credential cannot be applied to a 'openai-completions' model/);
    });

    it('treats an empty api as non-Anthropic, not as the default', () => {
      const blank = { id: 'x', api: '', headers: {} } as never;
      expect(() =>
        applyModelGateway(blank, {
          upstreamCredential: { mode: 'direct', value: 'sk-caller' }, // notsecret
        }),
      ).toThrow(/cannot be applied to a '' model/);
    });

    it('still returns the model untouched when no caller credential is in play', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://env-gw/v1';
      expect(applyModelGateway(openaiModel, {})).toBe(openaiModel);
    });
  });

  describe("an upstream credential's header (#368)", () => {
    it("sends it as x-api-key and strips Authorization when the header is 'x-api-key'", () => {
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://api.anthropic.com',
        upstreamCredential: { mode: 'direct', value: 'sk-ant-api03-x', header: 'x-api-key' }, // notsecret
      }) as any;
      expect(m.headers['x-api-key']).toBe('sk-ant-api03-x'); // notsecret
      expect(m.headers.Authorization).toBeNull();
    });

    it('keeps the caller key out of the environment on the x-api-key path too (MI1 R2)', () => {
      applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://api.anthropic.com',
        upstreamCredential: { mode: 'direct', value: 'sk-ant-api03-x', header: 'x-api-key' }, // notsecret
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
      expect(JSON.stringify(process.env)).not.toContain('sk-ant-api03-x');
    });

    it("treats an explicit 'authorization' exactly like an absent header", () => {
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example',
        upstreamCredential: { mode: 'direct', value: 'gw', header: 'authorization' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer gw');
      expect(m.headers['x-api-key']).toBeNull();
    });

    it('never applies a header choice to the deployment token: only a caller credential carries one', () => {
      // An empty-valued upstream credential falls through to the deployment token; its header must
      // not ride along and turn the deployment's gateway Bearer into x-api-key.
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example',
        anthropicAuthToken: 'deploy-tok', // notsecret
        upstreamCredential: { mode: 'direct', value: '', header: 'x-api-key' },
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer deploy-tok'); // notsecret
      expect(m.headers['x-api-key']).toBeNull();
    });
  });
});
