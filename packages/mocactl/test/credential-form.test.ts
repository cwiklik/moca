import { describe, expect, it } from 'vitest';
import { toPutRequest, validateCredential } from '../src/core/credential-checks.js';
import { credentialFields } from '../src/views/overlays/credential-form.js';

const base = {
  name: 'anthropic',
  kind: 'bearer',
  consumer: 'inference',
  hosts: 'api.anthropic.com',
  endpoint: '',
};

describe('credentialFields', () => {
  it('shows only the secret fields of the chosen kind', () => {
    const visible = (values: Record<string, string>) =>
      credentialFields()
        .filter((f) => !f.visible || f.visible(values))
        .map((f) => f.key);
    expect(visible(base)).toEqual(['name', 'kind', 'consumer', 'hosts', 'endpoint', 'token']);
    expect(visible({ ...base, kind: 'basic', consumer: 'sandbox-egress' })).toEqual([
      'name',
      'kind',
      'consumer',
      'hosts',
      'username',
      'password',
    ]);
    expect(visible({ ...base, kind: 'sigv4' })).toContain('secretPairs');
  });

  it('masks every secret field', () => {
    const secretFields = credentialFields().filter((f) =>
      ['token', 'password', 'key', 'accessToken', 'secretPairs'].includes(f.key),
    );
    // Guards against the loop below passing vacuously if a rename or a filter typo drops a field.
    expect(secretFields).toHaveLength(5);
    for (const f of secretFields) {
      expect(f.masked, f.key).toBe(true);
    }
  });

  it('never suggests a /v1 suffix on the gateway endpoint', () => {
    // The endpoint becomes the turn's ANTHROPIC_BASE_URL and the model client appends the API
    // path itself, so copying a `…/v1` example would double the version segment.
    const hint = credentialFields().find((f) => f.key === 'endpoint')!.hint!;
    expect(hint).toContain('ANTHROPIC_BASE_URL');
    expect(hint).not.toMatch(/https?:\/\/\S*\/v1\b/);
  });
});

describe('validateCredential', () => {
  it('accepts a valid inference credential', () => {
    expect(validateCredential({ ...base, token: 'x' })).toBeUndefined();
  });

  it.each([
    [{ ...base, name: 'Bad_Name' }, /lower-case letters, digits and dashes/],
    [{ ...base, consumer: 'nope' }, /consumer must be one of/],
    [{ ...base, hosts: '' }, /destination hosts: at least one host is required/],
    [{ ...base, hosts: ' , ,' }, /destination hosts: at least one host is required/],
    [{ ...base, kind: 'basic' }, /inference credential needs a single-secret kind/],
  ])('rejects %j', (values, message) => {
    expect(validateCredential(values)).toMatch(message);
  });

  it('refuses an unknown kind for an inference consumer unless it has exactly one secret field', () => {
    expect(
      validateCredential({ ...base, kind: 'sigv4', secretPairs: 'accessKey=a,secretKey=b' }),
    ).toMatch(/inference credential needs a single-secret kind.*'sigv4' has 2/);
    expect(
      validateCredential({ ...base, kind: 'sigv4', secretPairs: 'accessKey=a' }),
    ).toBeUndefined();
  });
});

describe('toPutRequest', () => {
  it('builds the request for a known kind', () => {
    expect(
      toPutRequest({
        ...base,
        hosts: 'api.anthropic.com, gw.example',
        endpoint: 'https://gw.example/v1',
        token: 'sk-x',
      }),
    ).toEqual({
      // notsecret
      name: 'anthropic',
      req: {
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['api.anthropic.com', 'gw.example'] },
        endpoint: 'https://gw.example/v1',
        secret: { token: 'sk-x' }, // notsecret
      },
    });
  });

  it('parses key=value pairs for an unknown kind and drops the endpoint for other consumers', () => {
    expect(
      toPutRequest({
        ...base,
        hosts: '',
        kind: 'sigv4',
        consumer: 'sandbox-egress',
        endpoint: 'ignored',
        secretPairs: 'accessKey=a, secretKey=b=c',
      }).req,
    ).toEqual({
      kind: 'sigv4',
      consumer: 'sandbox-egress',
      destination: { hosts: [] },
      secret: { accessKey: 'a', secretKey: 'b=c' },
    });
  });
});

describe('validateCredential: inference shapes that would 401 (#368)', () => {
  const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
  const anthropic = {
    ...base,
    kind: 'api-key',
    endpoint: 'https://api.anthropic.com',
    key: RAW_KEY,
  };

  it('accepts a raw Anthropic key as kind api-key to the bare origin', () => {
    expect(validateCredential(anthropic)).toBeUndefined();
  });

  it('accepts a gateway token as kind bearer with the gateway endpoint', () => {
    expect(
      validateCredential({ ...base, endpoint: 'https://litellm.internal', token: 'gw' }),
    ).toBeUndefined();
  });

  it.each([
    [{ ...base, token: RAW_KEY }, /kind api-key/],
    [{ ...base, endpoint: 'https://api.anthropic.com', token: 'gw' }, /x-api-key/],
    [{ ...anthropic, endpoint: 'https://api.anthropic.com/v1' }, /no \/v1/],
    [{ ...anthropic, endpoint: 'not a url' }, /absolute URL/],
  ])('refuses %o', (values, message) => {
    expect(validateCredential(values)).toMatch(message);
  });

  it('leaves an api-key credential with no endpoint to the server, which knows the default', () => {
    expect(validateCredential({ ...anthropic, endpoint: '' })).toBeUndefined();
  });

  it('never echoes the key in a message', () => {
    expect(validateCredential({ ...base, token: RAW_KEY })).not.toContain(RAW_KEY);
  });

  it('leaves a sandbox-egress credential alone', () => {
    expect(
      validateCredential({ ...base, consumer: 'sandbox-egress', token: RAW_KEY }),
    ).toBeUndefined();
  });

  it('names both working shapes in the kind hint', () => {
    const hint = credentialFields().find((f) => f.key === 'kind')!.hint!;
    expect(hint).toContain('bearer');
    expect(hint).toContain('api-key');
    expect(hint).toContain('oauth2-token');
  });
});

describe('validateCredential: Anthropic OAuth tokens (#595)', () => {
  const OAT = 'sk-ant-oat01-not-real'; // notsecret
  const claudePro = {
    name: 'claude-pro',
    kind: 'oauth2-token',
    consumer: 'inference',
    hosts: 'api.anthropic.com',
    endpoint: 'https://api.anthropic.com',
    accessToken: OAT,
  };

  it('accepts a Claude Pro/Max OAuth token as kind oauth2-token to the bare origin', () => {
    expect(validateCredential(claudePro)).toBeUndefined();
  });

  it('accepts the same token under kind bearer, the other Bearer shape', () => {
    expect(validateCredential({ ...claudePro, kind: 'bearer', token: OAT })).toBeUndefined();
  });

  it('accepts it with no endpoint, which the deployment default resolves', () => {
    expect(validateCredential({ ...claudePro, endpoint: '' })).toBeUndefined();
  });

  it.each([
    [{ ...claudePro, endpoint: 'https://litellm.internal' }, /only read by api\.anthropic\.com/],
    [{ ...claudePro, kind: 'api-key', key: OAT }, /Authorization/],
  ])('refuses %o', (values, message) => {
    expect(validateCredential(values)).toMatch(message);
  });

  it('never echoes the token in a message', () => {
    expect(
      validateCredential({ ...claudePro, endpoint: 'https://litellm.internal' }),
    ).not.toContain(OAT);
  });
});
