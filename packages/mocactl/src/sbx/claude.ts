import { spawn } from 'node:child_process';
import { SBX_EXIT, type SbxCtx } from './commands.js';
import { SERVER } from './agent-config.js';

/**
 * `mocactl sbx claude` (#577): Claude Code pointed at this sandbox for one run, with the
 * first-session approval question taken out of the way.
 *
 * Why a launcher, when `up` already writes `.mcp.json` and `enabledMcpjsonServers`: those keys
 * pre-approve the server only once Claude Code also trusts the folder, and that trust lives in
 * `~/.claude.json`, where only the user's own answer to the dialog puts it — `up` cannot and
 * should not write there. Both gates are also recorded against the directory `claude` was
 * started **in**, while `.mcp.json` is found by searching upwards, so a session started below
 * the root asks every time, whatever `up` wrote. `--mcp-config` carries the server for this one
 * run instead: flag-scoped, so no approval is asked, nothing is written anywhere (not even the
 * sticky `disabledMcpjsonServers` rejection a past decline left — the flag-scoped server is not
 * the project-scoped one that key disables), and the JSON names the server explicitly, so the
 * directory `claude` was started in no longer matters. `--strict-mcp-config` keeps the
 * project-scoped copy in `.mcp.json` from being loaded and asked about as well (verified
 * against claude 2.1.308, from the root, from a subdirectory, and over a past decline).
 *
 * `--strict-mcp-config` also means the session loads no MCP server but this one. That is the
 * same containment `up` applies when it denies the local tools: the agent works through the
 * sandbox. Run `claude` yourself when you want your other servers, and answer its one question.
 */

/**
 * The `--mcp-config` value: this sandbox's MCP server as the JSON Claude Code documents for the
 * flag (it takes a file path or an inline string; inline leaves nothing behind to clean up).
 *
 * With no `id`, `mocactl sbx mcp` resolves the binding itself, as it does for Claude Code and
 * OpenCode, so the agent follows `up`'s binding rather than a copy of it. An explicit
 * `--sandbox ID` is passed on, so it reaches the server that is actually started; so is an
 * explicit `--control-plane-url`, which otherwise would steer only the launcher — Claude Code
 * passes its whole environment to a stdio server (unlike Codex, #639), so the env-var case
 * arrives without help, but a flag is not the environment.
 */
export function serverConfig(id?: string, url?: string): string {
  const args = ['sbx', 'mcp'];
  if (id) args.push('--sandbox', id);
  if (url) args.push('--control-plane-url', url);
  return JSON.stringify({ mcpServers: { [SERVER]: { command: 'mocactl', args } } });
}

/**
 * What `claude` is run with: the server, strictly, then the caller's own arguments, so a user's
 * `--mcp-config` (the flag takes several) or model choice wins by coming later.
 */
export function claudeArgs(rest: readonly string[], id?: string, url?: string): string[] {
  return ['--mcp-config', serverConfig(id, url), '--strict-mcp-config', ...rest];
}

/** What `cmdClaude` needs of a child process: its exit code, or why it could not start. */
export interface ClaudeChild {
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
}

export interface ClaudeDeps {
  /** Injected in tests; spawns the real `claude` otherwise. */
  spawnClaude?: (args: string[]) => ClaudeChild;
}

/**
 * Runs `claude` with this sandbox's MCP server, inheriting the terminal (Claude Code is a TUI),
 * and exits with its code. `sandboxId` is only set when the user named one with `--sandbox`.
 */
export async function cmdClaude(
  c: SbxCtx,
  rest: readonly string[],
  deps: ClaudeDeps = {},
  sandboxId?: string,
  urlFromFlag?: string,
): Promise<number> {
  // `--json` is refused before dispatch: `claude` is in the CLI's NO_JSON set, since a TUI
  // prints none and a caller parsing stdout would get the TUI.
  const args = claudeArgs(rest, sandboxId, urlFromFlag);
  const child: ClaudeChild = deps.spawnClaude
    ? deps.spawnClaude(args)
    : spawn('claude', args, { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      c.io.err(
        err.code === 'ENOENT'
          ? 'sbx: claude is not on PATH: install Claude Code (npm i -g @anthropic-ai/claude-code), ' +
              `or run it yourself with: claude --mcp-config '${serverConfig(sandboxId, urlFromFlag)}' ` +
              '--strict-mcp-config'
          : `sbx: could not run claude: ${err.message}`,
      );
      resolve(SBX_EXIT.failed);
    });
    child.on('exit', (code: number | null) => resolve(code ?? SBX_EXIT.failed));
  });
}
