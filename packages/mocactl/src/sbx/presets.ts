import type { Preset } from './credentials.js';

/**
 * The credential presets `mocactl sbx credentials add --preset ID` knows: data only, and a `.ts`
 * module (not `.json`) because mocactl's tsconfig and esbuild bundle take no JSON imports today.
 * Adding one is a reviewed edit to this array, nothing else. Every `destinations` entry is
 * `host[:port][/prefix]`; `stdinField` is the one secret field read from stdin, `fixed` the rest.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'github',
    description: 'GitHub: git over HTTPS and the REST API (gh)',
    hint: 'use a fine-grained PAT limited to the repositories your sandboxes need: MOCA does not narrow it',
    credentials: [
      {
        suffix: '',
        kind: 'basic',
        destinations: ['github.com', 'api.github.com'],
        fixed: { username: 'x-access-token' },
        stdinField: 'password',
      },
    ],
  },
  {
    id: 'github-mcp',
    description: "GitHub's remote MCP server (Streamable HTTP)",
    hint: 'the same fine-grained PAT works; no token is needed in .mcp.json, the host sets it',
    credentials: [
      {
        suffix: '',
        kind: 'bearer',
        destinations: ['api.githubcopilot.com'],
        fixed: {},
        stdinField: 'token',
      },
    ],
  },
];
