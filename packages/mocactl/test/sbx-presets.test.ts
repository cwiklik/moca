import { describe, expect, it } from 'vitest';
import * as presetsModule from '../src/sbx/presets.js';
import { PRESETS } from '../src/sbx/presets.js';

/**
 * A local copy of the control plane's destination grammar (egress-destination.ts, Task 5):
 * host[:port][/prefix], no URL, whitespace, IPv6 literal, % ? # \ or dot segments.
 */
const DESTINATION =
  /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?(\/[A-Za-z0-9._~!$&'()*+,;=:@-]+(\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*)?$/;
const KINDS = ['bearer', 'basic', 'api-key', 'oauth2-token'];

describe('the sbx credential preset catalog', () => {
  it('exports PRESETS and nothing else: data only', () => {
    expect(Object.keys(presetsModule)).toEqual(['PRESETS']);
    // No functions, no classes: it survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(PRESETS))).toEqual(PRESETS);
  });

  it('ships github and github-mcp', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['github', 'github-mcp']);
  });

  it('has unique ids, a hint, a description and 1-4 credentials per entry', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(p.hint.trim()).not.toBe('');
      expect(p.description.trim()).not.toBe('');
      expect(p.credentials.length).toBeGreaterThanOrEqual(1);
      expect(p.credentials.length).toBeLessThanOrEqual(4);
    }
  });

  it('has unique suffixes within an entry, the first one empty', () => {
    for (const p of PRESETS) {
      const suffixes = p.credentials.map((c) => c.suffix);
      expect(suffixes[0]).toBe('');
      expect(new Set(suffixes).size).toBe(suffixes.length);
    }
  });

  it('uses only known kinds, valid destinations, and a stdin field the preset does not fix', () => {
    for (const p of PRESETS) {
      for (const c of p.credentials) {
        expect(KINDS).toContain(c.kind);
        expect(c.destinations.length).toBeGreaterThanOrEqual(1);
        for (const d of c.destinations) expect(d).toMatch(DESTINATION);
        expect(Object.keys(c.fixed)).not.toContain(c.stdinField);
      }
    }
  });

  it('has one stdinField per preset', () => {
    for (const p of PRESETS) {
      expect(new Set(p.credentials.map((c) => c.stdinField)).size).toBe(1);
    }
  });

  it('pins the first two entries', () => {
    const github = PRESETS.find((p) => p.id === 'github')!;
    expect(github.credentials).toEqual([
      {
        suffix: '',
        kind: 'basic',
        destinations: ['github.com', 'api.github.com'],
        fixed: { username: 'x-access-token' },
        stdinField: 'password',
      },
    ]);
    const mcp = PRESETS.find((p) => p.id === 'github-mcp')!;
    expect(mcp.credentials).toEqual([
      {
        suffix: '',
        kind: 'bearer',
        destinations: ['api.githubcopilot.com'],
        fixed: {},
        stdinField: 'token',
      },
    ]);
  });
});
