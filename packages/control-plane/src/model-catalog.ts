import type { InferenceAuthHeader } from './credential-store.js';
import { CpError } from './errors.js';
import { MODEL_ID_RE, sanitizeLimits, type ModelEntry, type ModelLimits } from './models.js';

/**
 * The model catalog (per-session model spec §4.1): which models a credential reaches, asked of the
 * endpoint the credential is already bound to -- the secret goes nowhere it does not already go.
 * `api.anthropic.com` answers `GET /v1/models` (ids only: the harness takes limits from pi's
 * registry, spec §5.2); any other endpoint is treated as LiteLLM and answers `GET /model/info`.
 */
export interface InferenceTarget {
  baseUrl: string;
  secret: string;
  header: InferenceAuthHeader;
}

export const CATALOG_TIMEOUT_MS = 5000;
const ANTHROPIC_HOST = 'api.anthropic.com';
/** Pages of 1000: Anthropic has a few dozen models, so this bounds a misbehaving `has_more`. */
const MAX_ANTHROPIC_PAGES = 20;

/**
 * The one thing a caller is told when the catalog cannot be read (PR #540 review, R1). Each failure
 * kind once had its own text -- refused, did not answer, not JSON, no data list, too large -- and
 * together they made the route an oracle for which hosts and ports the control plane reaches. The
 * kind and the host go to the server log instead; never the path, the query or the secret.
 */
export const CATALOG_UNAVAILABLE_MESSAGE = 'the inference endpoint could not list its models';

/** A catalog failure carrying its server-side reason; the caller sees only the uniform message. */
class CatalogUnreadable extends CpError {
  constructor(readonly reason: string) {
    super('model_catalog_unavailable', CATALOG_UNAVAILABLE_MESSAGE);
  }
}
const unavailable = (why: string) => new CatalogUnreadable(why);

/**
 * Wildcard routes kept from one catalog (R7). A route is checked against an id in O(id × pattern),
 * and only the 4 MiB body cap bounded their number -- ~15k hostile patterns made one PATCH cost
 * ~10⁹ steps on the event loop. Real LiteLLM deployments have a handful.
 */
export const MAX_CATALOG_PATTERNS = 64;

/**
 * The hosts the catalog may contact (R1): `api.anthropic.com`, the deployment default endpoint's
 * host, and the operator's `SH_MODEL_CATALOG_HOSTS`. The endpoint is the user's to choose, so an
 * unchecked fetch let any user with a credential probe the control plane's network (Redis, the
 * identity provider, the k8s API, link-local metadata). Private ranges cannot simply be refused:
 * LiteLLM in-cluster on a private address is the primary case. Exact, lower-case hostnames.
 */
export function catalogAllowList(
  extraHosts: readonly string[],
  defaultInferenceEndpoint?: string,
): ReadonlySet<string> {
  const hosts = new Set<string>([ANTHROPIC_HOST, ...extraHosts.map((h) => h.toLowerCase())]);
  const dflt = defaultInferenceEndpoint ? URL.parse(defaultInferenceEndpoint)?.hostname : undefined;
  if (dflt) hosts.add(dflt);
  return hosts;
}

/** A catalog body larger than this is refused unread (final review F9): no model list is near it. */
export const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

async function getJson(
  url: URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  // redirect: 'error' prevents cross-origin redirects from forwarding the x-api-key header
  // (Fetch spec strips only Authorization on cross-origin redirects, not custom headers).
  const res = await fetchImpl(url.toString(), { headers, signal, redirect: 'error' });
  if (!res.ok) {
    // The status stays server-side (final review F2, R1); fetchModelCatalog logs it with the host.
    // The body is cancelled, not left for the GC to drain, so the socket is released now.
    await res.body?.cancel().catch(() => {});
    throw unavailable(`answered ${res.status}`);
  }
  const text = await readCapped(res, MAX_CATALOG_BODY_BYTES);
  if (text === undefined) throw unavailable('answered with a body over the size cap');
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable('answered with a body that is not JSON');
  }
}

/** The body as text, or undefined once it passes `cap` bytes -- read no further than that. */
async function readCapped(res: Response, cap: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * What a credential reaches: the listed models, and the wildcard routes (LiteLLM `model_name`s with
 * a `*`, e.g. `anthropic/*`) that are not models but accept any id they match (final review F8).
 * Only `models` is shown to a caller (GET /v1/models); `patterns` only widens chooseModel.
 */
export interface ModelCatalog {
  models: ModelEntry[];
  patterns: string[];
}

/**
 * LiteLLM's `/model/info` → entries, chat models only, one per name with the smallest limits.
 * Wildcard routes go to `patterns`, not the list: listed literally they are an id no request can
 * use, and a concrete id they route would fail as unlisted.
 */
export function parseLiteLLMModelInfo(body: unknown): ModelCatalog {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw unavailable('its /model/info has no data list');
  const byId = new Map<string, ModelEntry>();
  const patterns = new Set<string>();
  let dropped = 0;
  for (const raw of data) {
    const row = (raw ?? {}) as { model_name?: unknown; model_info?: Record<string, unknown> };
    const id = row.model_name;
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) continue;
    const info = row.model_info ?? {};
    if (info.mode !== undefined && info.mode !== null && info.mode !== 'chat') continue;
    if (id.includes('*')) {
      if (patterns.size < MAX_CATALOG_PATTERNS) patterns.add(id);
      else if (!patterns.has(id)) dropped++;
      continue;
    }
    const limits =
      sanitizeLimits({
        contextWindow: info.max_input_tokens,
        maxTokens: info.max_output_tokens,
        reasoning: info.supports_reasoning,
        vision: info.supports_vision,
      }) ?? {};
    const prev = byId.get(id);
    byId.set(id, prev ? { id, ...smaller(prev, limits) } : { id, ...limits });
  }
  if (dropped > 0) {
    console.error(
      `[control-plane] model catalog: kept ${MAX_CATALOG_PATTERNS} wildcard routes, dropped ${dropped} more`,
    );
  }
  return { models: [...byId.values()], patterns: [...patterns] };
}

/** `*` is any run of characters (none included); the rest literal; the whole id must match. */
function matchesPattern(id: string, pattern: string): boolean {
  // A glob match, not a RegExp: the pattern comes from the credential's endpoint, which the user
  // chooses, and `.*`-per-star backtracking is exponential in the stars -- one request could block
  // the event loop for minutes. Greedy two-pointer matching, backtracking only to the last star,
  // is O(id × pattern).
  let i = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (i < id.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === id[i]) {
      i++;
      p++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = i;
    } else if (star !== -1) {
      p = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Two deployments behind one name: the request must fit both, so take the smaller of each. */
function smaller(a: ModelLimits, b: ModelLimits): ModelLimits {
  const min = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.min(x, y);
  const and = (x?: boolean, y?: boolean) => (x === undefined ? y : y === undefined ? x : x && y);
  return (
    sanitizeLimits({
      contextWindow: min(a.contextWindow, b.contextWindow),
      maxTokens: min(a.maxTokens, b.maxTokens),
      reasoning: and(a.reasoning, b.reasoning),
      vision: and(a.vision, b.vision),
    }) ?? {}
  );
}

/**
 * A path without trailing slashes, by a loop rather than /\/+$/: that regex is quadratic on a long
 * run of slashes followed by anything else, and the endpoint is the user's to choose.
 */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/**
 * `suffix` under the endpoint's path, built with the URL API (R1): the endpoint's query and fragment
 * are dropped, so neither `…/admin?` nor `…#` can swallow the suffix and aim the request elsewhere.
 * An existing path prefix (`/v1`) is kept.
 */
function catalogUrl(endpoint: URL, suffix: string): URL {
  const base = new URL(endpoint);
  base.search = '';
  base.hash = '';
  base.pathname = `${trimTrailingSlashes(base.pathname)}/`;
  return new URL(suffix, base);
}

/**
 * The credential's catalog, asked only of an allow-listed host (`catalogAllowList`). Every failure
 * -- not allow-listed, refused, did not answer, not JSON, no data list, too large -- is the same
 * `model_catalog_unavailable` to the caller; the host and the reason are logged here.
 */
export async function fetchModelCatalog(
  target: InferenceTarget,
  allowedHosts: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CATALOG_TIMEOUT_MS,
): Promise<ModelCatalog> {
  const endpoint = URL.parse(target.baseUrl);
  const host = endpoint?.hostname ?? 'an unparseable endpoint';
  try {
    if (!endpoint) throw unavailable('is not a URL');
    // Not fetched at all: the same outcome as an unreadable catalog (create/PATCH accept the id
    // unverified), so an unlisted host is neither contacted nor told apart from a dead one.
    if (!allowedHosts.has(endpoint.hostname)) {
      throw unavailable('is not in the catalog allow-list (SH_MODEL_CATALOG_HOSTS)');
    }
    return await readCatalog(endpoint, target, fetchImpl, timeoutMs);
  } catch (err) {
    const reason =
      err instanceof CatalogUnreadable
        ? err.reason
        : err instanceof CpError
          ? undefined
          : // A network failure or a timeout. The error's own text can carry the URL, never the
            // secret, but it is dropped anyway.
            'did not answer';
    if (reason === undefined) throw err;
    console.error(`[control-plane] model catalog: ${host} ${reason}`);
    throw err instanceof CatalogUnreadable ? err : unavailable(reason);
  }
}

async function readCatalog(
  endpoint: URL,
  target: InferenceTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ModelCatalog> {
  const isAnthropic = endpoint.hostname === ANTHROPIC_HOST;
  const headers: Record<string, string> =
    target.header === 'x-api-key'
      ? { 'x-api-key': target.secret }
      : { authorization: `Bearer ${target.secret}` };
  if (isAnthropic) {
    headers['anthropic-version'] = '2023-06-01';
    // An Anthropic OAuth token is read only with the oauth beta header (#595), the same pair pi's
    // client sends for a Claude Pro login. A raw key sends no beta and is unaffected.
    if (target.secret.startsWith('sk-ant-oat')) {
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
    }
  }
  // One timeout signal bounds the entire catalog call, all pages included.
  const signal = AbortSignal.timeout(timeoutMs);
  if (!isAnthropic) {
    return parseLiteLLMModelInfo(
      await getJson(catalogUrl(endpoint, 'model/info'), headers, fetchImpl, signal),
    );
  }
  // Anthropic has no wildcard routes.
  const out: ModelEntry[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
    const url = catalogUrl(endpoint, 'v1/models');
    url.searchParams.set('limit', '1000');
    if (after) url.searchParams.set('after_id', after);
    const body = (await getJson(url, headers, fetchImpl, signal)) as {
      data?: unknown;
      has_more?: unknown;
      last_id?: unknown;
    };
    if (!Array.isArray(body?.data)) throw unavailable('its /v1/models has no data list');
    for (const m of body.data as Array<{ id?: unknown }>) {
      if (typeof m?.id === 'string' && MODEL_ID_RE.test(m.id)) out.push({ id: m.id });
    }
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  return { models: out, patterns: [] };
}

export type ModelChoice = { model: string; limits?: ModelLimits; verified: boolean };

/**
 * Check a model id against the credential's catalog (spec §4.2). Listed: its limits. Not listed but
 * matched by a wildcard route: accepted verified, with no limits (the route names none). Neither:
 * `model_unavailable`. Catalog unreadable, or its host not allow-listed: accepted unverified, so a gateway outage never blocks a
 * new session; a wrong id then fails its first turn with the gateway's own error.
 */
export async function chooseModel(
  target: InferenceTarget,
  id: string,
  credential: string,
  allowedHosts: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelChoice> {
  let catalog: ModelCatalog;
  try {
    catalog = await fetchModelCatalog(target, allowedHosts, fetchImpl);
  } catch (err) {
    if (err instanceof CpError && err.code === 'model_catalog_unavailable') {
      return { model: id, verified: false };
    }
    throw err;
  }
  const hit = catalog.models.find((m) => m.id === id);
  if (!hit) {
    // An id that itself holds a `*` is a route, not a model: it never matches one (F8).
    if (!id.includes('*') && catalog.patterns.some((p) => matchesPattern(id, p))) {
      return { model: id, verified: true };
    }
    throw new CpError(
      'model_unavailable',
      `credential '${credential}' does not offer model '${id}' (it offers ${catalog.models.length} models; list them with GET /v1/models)`,
    );
  }
  const { id: _id, ...limits } = hit;
  return {
    model: id,
    ...(sanitizeLimits(limits) ? { limits: sanitizeLimits(limits) } : {}),
    verified: true,
  };
}
