import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeCredential } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/** #368: which header the data plane sends the subject's credential in. */
async function sessionToken(d: CpDeps, id = 'sid-hdr'): Promise<string> {
  const res = await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
    ...d,
    newId: () => id,
  });
  return (res.body as { token: string }).token;
}

const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
const anthropicKey = {
  kind: 'api-key',
  destination: { hosts: ['api.anthropic.com'] },
  endpoint: 'https://api.anthropic.com',
  secret: { key: RAW_KEY },
};

describe('exchangeCredential: authHeader', () => {
  let d: CpDeps;
  beforeEach(() => {
    d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
  });

  it('omits authHeader for a Bearer credential, so the pre-#368 wire shape is unchanged', async () => {
    await seedCredential(d);
    const res = await exchangeCredential(await sessionToken(d), d);
    expect(res).not.toHaveProperty('authHeader');
  });

  it("returns authHeader 'x-api-key' and the raw key for an api-key credential in direct mode", async () => {
    await seedCredential(d, 'github:1234', 'my-anthropic', anthropicKey);
    const res = await exchangeCredential(await sessionToken(d), d);
    expect(res.authHeader).toBe('x-api-key');
    expect(res.anthropicAuthToken).toBe(RAW_KEY);
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });

  it('keeps placeholder mode on Bearer <placeholder> whatever the binding: the injector picks the upstream header', async () => {
    // Final review, Important 1: the harness never holds the secret in placeholder mode, so the
    // harness-to-injector header carries no meaning, and AB1's injector already sets its own
    // upstream header (ab1-deployment.yaml inject_header). Pre-#368 this credential sent
    // `Bearer <placeholder>`; it still does.
    const inj = makeDeps({ config: { exchangeToken: 'shared-abc', injectorConfigured: true } }); // notsecret
    await seedCredential(inj, 'github:1234', 'my-anthropic', anthropicKey);
    const res = await exchangeCredential(await sessionToken(inj), inj);
    expect(res.mode).toBe('placeholder');
    expect(res.anthropicAuthToken).toBe('sh-placeholder-github:1234');
    expect(res).not.toHaveProperty('authHeader');
  });

  it('refuses a raw Anthropic key whose resolved endpoint is not api.anthropic.com', async () => {
    // Final review, Important 2: no endpoint on the credential and a gateway default would send the
    // user's Anthropic key to a host they never named, and 401 there.
    const gw = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: 'https://litellm.internal' }, // notsecret
    });
    await seedCredential(gw, 'github:1234', 'my-anthropic', {
      ...anthropicKey,
      endpoint: undefined,
    });
    const token = await sessionToken(gw);
    let message = '';
    try {
      await exchangeCredential(token, gw);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain('https://api.anthropic.com');
    expect(message).not.toContain(RAW_KEY);
  });

  it('refuses a stored binding the inference path cannot send, never falling back to Bearer', async () => {
    // Review Focus 5: a credential written before Task 1's check existed. Bypasses parseCredentialBody.
    await d.credentials.put('github:1234', {
      descriptor: {
        name: 'my-anthropic',
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['litellm.internal'] },
        binding: { header: 'X-Custom', format: '{token}' },
        endpoint: 'https://litellm.internal',
      },
      secret: { token: 'gw-fake' }, // notsecret
    });
    const token = await sessionToken(d);
    let message = '';
    try {
      await exchangeCredential(token, d);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("'my-anthropic'");
    expect(message).not.toContain('gw-fake');
  });

  it('keeps the operator fallback on Bearer', async () => {
    const fb = makeDeps({
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: 'op-gw-token', // notsecret
        defaultInferenceEndpoint: 'https://litellm.internal',
      },
    });
    // A subject with no inference credential at all, which the fallback lets create a session.
    const token = await sessionToken(fb);
    const res = await exchangeCredential(token, fb);
    expect(res.anthropicAuthToken).toBe('op-gw-token'); // notsecret
    expect(res).not.toHaveProperty('authHeader');
  });

  describe('a misconfigured operator fallback (PR #372 review)', () => {
    // Both direct-mode endpoint checks see the fallback's token too. The refusal is right, but the
    // user does not own `operator-fallback` and cannot re-store it: the message must send them to
    // the operator, name the settings, and the code must blame the deployment, not the caller.
    const fallback = async (token: string, endpoint: string) => {
      const fb = makeDeps({
        config: {
          exchangeToken: 'shared-abc', // notsecret
          allowOperatorFallback: true,
          operatorInferenceToken: token,
          defaultInferenceEndpoint: endpoint,
        },
      });
      const session = await sessionToken(fb);
      // The data plane maps a 5xx to a generic "control plane returned 503" (turn-auth PASSTHROUGH
      // admits caller-attributable codes only), so the operator learns of this from the log.
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await exchangeCredential(session, fb);
      } catch (e) {
        return {
          code: (e as { code: string }).code,
          message: (e as Error).message,
          logged: log.mock.calls.map((c) => c.join(' ')).join('\n'),
        };
      } finally {
        log.mockRestore();
      }
      throw new Error('expected a refusal');
    };

    it('a raw Anthropic operator key on a gateway default: operator-facing, not caller-facing', async () => {
      const r = await fallback(RAW_KEY, 'https://litellm.internal');
      expect(r.code).toBe('credential_unavailable');
      expect(r.message).toContain('SH_OPERATOR_INFERENCE_TOKEN');
      expect(r.message).toContain('SH_DEFAULT_INFERENCE_ENDPOINT');
      expect(r.message).not.toContain('set its endpoint');
      expect(r.message).not.toContain(RAW_KEY);
      expect(r.logged).toContain('SH_OPERATOR_INFERENCE_TOKEN');
      expect(r.logged).not.toContain(RAW_KEY);
    });

    it('a Bearer operator token on an api.anthropic.com default: operator-facing too', async () => {
      const r = await fallback('op-gw-token', 'https://api.anthropic.com'); // notsecret
      expect(r.code).toBe('credential_unavailable');
      expect(r.message).toContain('SH_OPERATOR_INFERENCE_TOKEN');
      expect(r.message).not.toContain("store the key with kind 'api-key'");
      expect(r.message).not.toContain('op-gw-token');
      expect(r.logged).toContain('SH_DEFAULT_INFERENCE_ENDPOINT');
      expect(r.logged).not.toContain('op-gw-token');
    });
  });

  it('sends the operator fallback under SH_OPERATOR_INFERENCE_HEADER: a raw operator key goes as x-api-key', async () => {
    const fb = makeDeps({
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: RAW_KEY,
        operatorInferenceHeader: 'x-api-key',
        defaultInferenceEndpoint: 'https://api.anthropic.com',
      },
    });
    const session = await sessionToken(fb, 'sid-op-xapi');
    const res = await exchangeCredential(session, fb);
    expect(res.authHeader).toBe('x-api-key');
    expect(res.anthropicAuthToken).toBe(RAW_KEY);
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });

  it('refuses a Bearer credential whose RESOLVED endpoint is api.anthropic.com', async () => {
    // No endpoint on the credential, and a deployment default of api.anthropic.com (compose
    // documents that default): Bearer there always 401s, and PUT could not know the default.
    const dflt = makeDeps({
      config: {
        exchangeToken: 'shared-abc',
        defaultInferenceEndpoint: 'https://api.anthropic.com',
      }, // notsecret
    });
    await seedCredential(dflt, 'github:1234', 'my-anthropic', {
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: undefined,
    });
    const token = await sessionToken(dflt);
    let message = '';
    try {
      await exchangeCredential(token, dflt);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("kind 'api-key'");
  });

  it('exchanges an Anthropic OAuth token as Bearer to api.anthropic.com in direct mode (#595)', async () => {
    const OAT = 'sk-ant-oat01-not-real'; // notsecret
    await seedCredential(d, 'github:1234', 'claude-pro', {
      kind: 'oauth2-token',
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: 'https://api.anthropic.com',
      secret: { accessToken: OAT },
    });
    const res = await exchangeCredential(await sessionToken(d), d);
    // Bearer is the default wire shape, so no authHeader is named.
    expect(res).not.toHaveProperty('authHeader');
    expect(res.anthropicAuthToken).toBe(OAT);
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });

  it('refuses an Anthropic OAuth token whose resolved endpoint is not api.anthropic.com', async () => {
    // No endpoint on the credential and a gateway default: the subscription token would go to a
    // host that cannot read it, which is a misdirected secret (spec §6.2), not a degraded request.
    const OAT = 'sk-ant-oat01-not-real'; // notsecret
    const gw = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: 'https://litellm.internal' }, // notsecret
    });
    await seedCredential(gw, 'github:1234', 'claude-pro', {
      kind: 'oauth2-token',
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: undefined,
      secret: { accessToken: OAT },
    });
    const token = await sessionToken(gw);
    let message = '';
    try {
      await exchangeCredential(token, gw);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("'claude-pro'");
    expect(message).toContain('https://api.anthropic.com');
    expect(message).not.toContain(OAT);
  });

  it('lets an api-key credential with no endpoint use an api.anthropic.com default', async () => {
    const dflt = makeDeps({
      config: {
        exchangeToken: 'shared-abc',
        defaultInferenceEndpoint: 'https://api.anthropic.com',
      }, // notsecret
    });
    await seedCredential(dflt, 'github:1234', 'my-anthropic', {
      ...anthropicKey,
      endpoint: undefined,
    });
    const res = await exchangeCredential(await sessionToken(dflt), dflt);
    expect(res.authHeader).toBe('x-api-key');
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });
});
