import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/main.js';
import { directModeMismatch } from '../src/exchange.js';

/** #368 phase 2: a misconfigured operator fallback is refused at BOOT, naming settings, never values. */
const { privateKey } = generateKeyPairSync('ed25519');
const baseEnv = {
  SH_SESSION_TOKEN_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  SH_CREDENTIAL_KEK: randomBytes(32).toString('base64'), // notsecret
  SH_GITHUB_CLIENT_ID: 'Iv1.fake', // notsecret
  SH_EXCHANGE_TOKEN: 'shared-abc', // notsecret
} as NodeJS.ProcessEnv;
const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
const GW_TOKEN = 'op-gateway-token'; // notsecret

function bootError(env: NodeJS.ProcessEnv): string {
  try {
    configFromEnv({ ...baseEnv, ...env });
  } catch (e) {
    return (e as Error).message;
  }
  return '<booted>';
}

describe('SH_OPERATOR_INFERENCE_HEADER', () => {
  it('defaults to authorization and accepts exactly the two inference headers', () => {
    expect(configFromEnv(baseEnv).operatorInferenceHeader).toBe('authorization');
    expect(
      configFromEnv({ ...baseEnv, SH_OPERATOR_INFERENCE_HEADER: 'x-api-key' })
        .operatorInferenceHeader,
    ).toBe('x-api-key');
    for (const v of ['X-API-Key', 'bearer', 'Authorization: Bearer']) {
      expect(bootError({ SH_OPERATOR_INFERENCE_HEADER: v }), v).toContain(
        'SH_OPERATOR_INFERENCE_HEADER',
      );
    }
  });
});

describe('checkInferenceConfig at boot', () => {
  it('boots a fallback that can work: a gateway token on Bearer, a raw key on x-api-key', () => {
    expect(
      bootError({
        SH_ALLOW_OPERATOR_FALLBACK: 'true',
        SH_OPERATOR_INFERENCE_TOKEN: GW_TOKEN,
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm.internal',
      }),
    ).toBe('<booted>');
    expect(
      bootError({
        SH_ALLOW_OPERATOR_FALLBACK: 'true',
        SH_OPERATOR_INFERENCE_TOKEN: RAW_KEY,
        SH_OPERATOR_INFERENCE_HEADER: 'x-api-key',
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
      }),
    ).toBe('<booted>');
  });

  it('checks nothing about the token while the fallback is off (the default)', () => {
    expect(bootError({ SH_OPERATOR_INFERENCE_TOKEN: RAW_KEY })).toBe('<booted>');
  });

  it('refuses the fallback on with no token (Review Focus 1)', () => {
    const m = bootError({
      SH_ALLOW_OPERATOR_FALLBACK: 'true',
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://gw',
    });
    expect(m).toContain('SH_OPERATOR_INFERENCE_TOKEN');
    expect(m).toContain('operator-inference-token'); // the deploy/vm file, so the VM operator knows where
  });

  it('refuses the fallback on with no default endpoint: the operator token has none of its own', () => {
    const m = bootError({
      SH_ALLOW_OPERATOR_FALLBACK: 'true',
      SH_OPERATOR_INFERENCE_TOKEN: GW_TOKEN,
    });
    expect(m).toContain('SH_DEFAULT_INFERENCE_ENDPOINT');
    expect(m).not.toContain(GW_TOKEN);
  });

  it('refuses a raw Anthropic operator key left on the default Bearer header (Review Focus 2)', () => {
    const m = bootError({
      SH_ALLOW_OPERATOR_FALLBACK: 'true',
      SH_OPERATOR_INFERENCE_TOKEN: RAW_KEY,
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
    });
    expect(m).toContain('SH_OPERATOR_INFERENCE_HEADER=x-api-key');
    expect(m).not.toContain(RAW_KEY);
  });

  it('refuses a raw Anthropic operator key aimed at a gateway', () => {
    const m = bootError({
      SH_ALLOW_OPERATOR_FALLBACK: 'true',
      SH_OPERATOR_INFERENCE_TOKEN: RAW_KEY,
      SH_OPERATOR_INFERENCE_HEADER: 'x-api-key',
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm.internal',
    });
    expect(m).toContain('https://api.anthropic.com');
    expect(m).not.toContain(RAW_KEY);
  });

  it('refuses an Anthropic OAuth token as the operator key: the fallback is shared by every caller', () => {
    // PR #658 review: an sk-ant-oat operator fallback would spend one person's Claude Pro/Max
    // subscription on every caller without their own credential — account sharing on a personal
    // plan. A caller's OWN OAuth credential is fine (exchange-auth-header.test.ts); the shared
    // fallback is not, whatever the header or endpoint.
    const oat = 'sk-ant-oat01-not-real'; // notsecret
    for (const env of [
      {
        SH_OPERATOR_INFERENCE_TOKEN: oat,
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
      },
      {
        SH_OPERATOR_INFERENCE_TOKEN: oat,
        SH_OPERATOR_INFERENCE_HEADER: 'x-api-key',
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
      },
      {
        SH_OPERATOR_INFERENCE_TOKEN: oat,
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm.internal',
      },
      // Placeholder mode too: the refusal is policy, not a wire-shape check.
      {
        SH_OPERATOR_INFERENCE_TOKEN: oat,
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
        SH_INJECTOR_CONFIGURED: 'true',
      },
    ]) {
      const m = bootError({ SH_ALLOW_OPERATOR_FALLBACK: 'true', ...env });
      expect(m, JSON.stringify(env)).toContain('sk-ant-oat');
      expect(m, JSON.stringify(env)).not.toContain(oat);
    }
  });

  it('skips the header check in placeholder mode, where the injector picks the upstream header', () => {
    expect(
      bootError({
        SH_ALLOW_OPERATOR_FALLBACK: 'true',
        SH_OPERATOR_INFERENCE_TOKEN: RAW_KEY,
        SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com',
        SH_INJECTOR_CONFIGURED: 'true',
      }),
    ).toBe('<booted>');
  });

  it('refuses an api.anthropic.com default endpoint with a path, fallback on or off (Review Focus 3)', () => {
    for (const ep of ['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/']) {
      expect(bootError({ SH_DEFAULT_INFERENCE_ENDPOINT: ep }), ep).toContain('no /v1');
    }
    expect(bootError({ SH_DEFAULT_INFERENCE_ENDPOINT: 'https://api.anthropic.com' })).toBe(
      '<booted>',
    );
    // A gateway's own path is its business (LiteLLM serves under /v1 on some installs).
    expect(bootError({ SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm/v1' })).toBe('<booted>');
  });

  it('refuses a default endpoint that is not a URL', () => {
    expect(bootError({ SH_DEFAULT_INFERENCE_ENDPOINT: 'litellm.internal' })).toContain(
      'SH_DEFAULT_INFERENCE_ENDPOINT',
    );
  });
});

describe('directModeMismatch', () => {
  it('names the shapes that 401 upstream and passes the rest', () => {
    const OAT = 'sk-ant-oat01-not-real'; // notsecret
    expect(directModeMismatch('authorization', GW_TOKEN, 'https://api.anthropic.com')).toBe(
      'bearer-to-anthropic',
    );
    expect(directModeMismatch('x-api-key', RAW_KEY, 'https://gw.example')).toBe(
      'raw-key-elsewhere',
    );
    expect(directModeMismatch('authorization', RAW_KEY, 'https://gw.example')).toBe(
      'raw-key-elsewhere',
    );
    // The one Bearer value api.anthropic.com reads: an OAuth token goes through (#595).
    expect(directModeMismatch('authorization', OAT, 'https://api.anthropic.com')).toBeUndefined();
    // And it is the only host that reads it: aimed anywhere else, it is a misdirected secret.
    expect(directModeMismatch('authorization', OAT, 'https://gw.example')).toBe(
      'oauth-token-elsewhere',
    );
    expect(directModeMismatch('x-api-key', RAW_KEY, 'https://api.anthropic.com')).toBeUndefined();
    expect(directModeMismatch('authorization', GW_TOKEN, 'https://gw.example')).toBeUndefined();
    expect(directModeMismatch('x-api-key', GW_TOKEN, 'https://gw.example')).toBeUndefined();
  });
});
