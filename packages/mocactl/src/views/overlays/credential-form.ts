import { CONSUMERS, KNOWN_KINDS, kindFields } from '../../core/credential-checks.js';
import type { FormField } from '../Form.js';

const LABELS: Record<string, string> = {
  token: 'Token',
  username: 'Username',
  password: 'Password',
  key: 'API key',
  accessToken: 'Access token',
};

export function credentialFields(): FormField[] {
  const secretFields = [...new Set(Object.values(KNOWN_KINDS).flat())];
  return [
    {
      key: 'name',
      label: 'Name',
      hint: 'lower-case letters, digits and dashes, e.g. anthropic-work',
    },
    {
      key: 'kind',
      label: 'Kind',
      initial: 'bearer',
      suggestions: Object.keys(KNOWN_KINDS),
      hint: 'inference: bearer for a gateway token (LiteLLM etc.), api-key for an Anthropic API key (sk-ant-api…), oauth2-token for a Claude Pro/Max OAuth token (sk-ant-oat…)',
    },
    { key: 'consumer', label: 'Consumer', initial: 'inference', suggestions: CONSUMERS },
    {
      key: 'hosts',
      label: 'Destination hosts',
      hint: 'comma-separated host allow-list, e.g. api.anthropic.com',
    },
    {
      key: 'endpoint',
      label: 'Gateway endpoint',
      optional: true,
      hint: 'the model gateway base URL, as for ANTHROPIC_BASE_URL — no /v1, e.g. https://litellm.internal, or https://api.anthropic.com for kind api-key; empty uses the deployment default',
      visible: (v) => v.consumer === 'inference',
    },
    ...secretFields.map((key) => ({
      key,
      label: LABELS[key] ?? key,
      masked: true,
      visible: (v: Record<string, string>) => (kindFields(v.kind) ?? []).includes(key),
    })),
    {
      key: 'secretPairs',
      label: 'Secret fields',
      masked: true,
      hint: 'key=value, key=value — the fields this kind requires',
      visible: (v) => !kindFields(v.kind),
    },
  ];
}
