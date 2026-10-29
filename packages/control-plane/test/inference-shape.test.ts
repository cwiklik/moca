import { describe, expect, it } from 'vitest';
import { CpError } from '../src/errors.js';
import { firstBinding, inferenceAuthHeader, parseCredentialBody } from '../src/credential-store.js';

/**
 * #368 scope 1 (#362 item 3): an inference credential goes upstream in exactly one of two headers,
 * and a shape that api.anthropic.com is known to 401 is refused at PUT, where the user can fix it,
 * rather than surfacing as an opaque 401 mid-turn.
 */
const inference = (over: Record<string, unknown> = {}) => ({
  kind: 'bearer',
  consumer: 'inference',
  destination: { hosts: ['litellm.internal'] },
  endpoint: 'https://litellm.internal',
  secret: { token: 'gw-fake' }, // notsecret
  ...over,
});

const refusal = (body: unknown): { code: string; message: string } => {
  try {
    parseCredentialBody('my-inference', body);
  } catch (e) {
    return { code: (e as CpError).code, message: (e as Error).message };
  }
  throw new Error('expected a refusal');
};

const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret

describe('inferenceAuthHeader', () => {
  it('maps the two sendable shapes, case-insensitively on the header name', () => {
    expect(
      inferenceAuthHeader({ header: 'Authorization', format: 'Bearer {token}' }, 'token'),
    ).toBe('authorization');
    expect(inferenceAuthHeader({ header: 'X-API-Key', format: '{key}' }, 'key')).toBe('x-api-key');
    expect(inferenceAuthHeader({ header: 'x-api-key', format: '{key}' }, 'key')).toBe('x-api-key');
  });

  it('returns undefined for anything else, including a format naming a different field', () => {
    expect(inferenceAuthHeader({ header: 'X-Custom', format: '{key}' }, 'key')).toBeUndefined();
    expect(
      inferenceAuthHeader({ header: 'Authorization', format: 'Token {token}' }, 'token'),
    ).toBeUndefined();
    expect(inferenceAuthHeader({ header: 'x-api-key', format: '{token}' }, 'key')).toBeUndefined();
  });
});

describe('parseCredentialBody: inference shapes', () => {
  it('accepts a gateway token over Bearer (the shape the #348 smoke uses)', () => {
    expect(() => parseCredentialBody('gw', inference())).not.toThrow();
  });

  it('accepts a raw Anthropic key as kind api-key to the bare api.anthropic.com origin', () => {
    const c = parseCredentialBody(
      'anthropic',
      inference({
        kind: 'api-key',
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: 'https://api.anthropic.com',
        secret: { key: RAW_KEY },
      }),
    );
    expect(inferenceAuthHeader(firstBinding(c.descriptor), 'key')).toBe('x-api-key');
  });

  it('refuses a binding the inference path cannot send', () => {
    const r = refusal(inference({ binding: { header: 'X-Custom', format: '{token}' } }));
    expect(r.code).toBe('invalid_request');
    expect(r.message).toContain('x-api-key');
  });

  it('refuses a raw Anthropic key on a Bearer binding, naming kind api-key', () => {
    // Review Focus 1: mocactl's form defaults to kind bearer, so this is the likely mistake.
    const r = refusal(inference({ secret: { token: RAW_KEY } }));
    expect(r.code).toBe('invalid_request');
    expect(r.message).toContain("kind 'api-key'");
  });

  it('accepts an Anthropic OAuth token as kind oauth2-token to the bare api.anthropic.com origin (#595)', () => {
    // api.anthropic.com also reads OAuth tokens (Authorization: Bearer, with the oauth beta header
    // the harness's pi client adds): a Claude Pro/Max subscription token is a working shape.
    const c = parseCredentialBody(
      'claude-pro',
      inference({
        kind: 'oauth2-token',
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: 'https://api.anthropic.com',
        secret: { accessToken: 'sk-ant-oat01-not-real' }, // notsecret
      }),
    );
    expect(inferenceAuthHeader(firstBinding(c.descriptor), 'accessToken')).toBe('authorization');
  });

  it('refuses an Anthropic OAuth token on an x-api-key binding, naming the Bearer header', () => {
    const r = refusal(
      inference({
        kind: 'api-key',
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: 'https://api.anthropic.com',
        secret: { key: 'sk-ant-oat01-not-real' }, // notsecret
      }),
    );
    expect(r.code).toBe('invalid_request');
    expect(r.message).toContain('sk-ant-oat');
    expect(r.message).toContain('Authorization');
  });

  it('refuses a non-OAuth Bearer credential to api.anthropic.com, whatever the value', () => {
    // Review Focus 3.
    const r = refusal(
      inference({
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: 'https://api.anthropic.com',
      }),
    );
    expect(r.code).toBe('invalid_request');
    expect(r.message).toContain('x-api-key');
  });

  it('refuses api.anthropic.com with a path, because the client appends /v1/messages itself', () => {
    // Review Focus 2.
    const r = refusal(
      inference({
        kind: 'api-key',
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: 'https://api.anthropic.com/v1',
        secret: { key: RAW_KEY },
      }),
    );
    expect(r.code).toBe('invalid_request');
    expect(r.message).toContain('https://api.anthropic.com');
  });

  it('never echoes the secret in a refusal', () => {
    expect(refusal(inference({ secret: { token: RAW_KEY } })).message).not.toContain(RAW_KEY);
  });

  it('leaves non-inference consumers alone', () => {
    expect(() =>
      parseCredentialBody('gh', {
        kind: 'bearer',
        consumer: 'sandbox-egress',
        destination: { hosts: ['api.github.com'] },
        binding: { header: 'X-Custom', format: '{token}' },
        secret: { token: 'sk-ant-api03-whatever' }, // notsecret
      }),
    ).not.toThrow();
  });
});
