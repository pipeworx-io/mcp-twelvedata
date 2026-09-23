interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Twelve Data MCP.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Twelve Data');
}

const BASE = 'https://api.twelvedata.com';
const UA = 'pipeworx-mcp-twelvedata/1.0 (+https://pipeworx.io)';

// Shared schema fragments. The `get` helper forwards every arg as a query param,
// so these must be DECLARED for the routing LLM to know to pass them (previously
// most tools shipped `properties: {}` with required fields the agent couldn't see).
const SYMBOL = {
  type: 'string' as const,
  description:
    'Ticker/symbol. Stocks e.g. "AAPL", "MSFT"; forex "EUR/USD"; crypto "BTC/USD"; ETFs "SPY". Comma-separate for a batch (e.g. "AAPL,MSFT"). Market indices (SPX, N225, …) need a Grow-or-higher Twelve Data key passed via _apiKey — the shared key cannot quote them.',
};
const INTERVAL = {
  type: 'string' as const,
  description: 'Bar interval: 1min, 5min, 15min, 30min, 45min, 1h, 2h, 4h, 1day, 1week, or 1month.',
};
const OUTPUTSIZE = { type: 'number' as const, description: 'Number of data points to return (1–5000, default 30).' };
const EXCHANGE = { type: 'string' as const, description: 'Optional exchange filter (e.g. "NASDAQ", "NYSE", "Binance").' };
const START_DATE = { type: 'string' as const, description: 'Optional start of range, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".' };
const END_DATE = { type: 'string' as const, description: 'Optional end of range, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".' };
const ORDER = { type: 'string' as const, description: 'Sort order: "asc" or "desc" (default desc, newest first).' };
const TIMEZONE = { type: 'string' as const, description: 'Optional timezone, e.g. "America/New_York" or "UTC".' };
// Reference lists (/etf, /indices) are UNBOUNDED upstream: an unfiltered /etf is
// 64,754 rows / 17 MB, which no model can read and which took a 25s fetch
// timeout mid-body on 2026-09-16 — reported to the caller as "200 response was
// not JSON" because the parse path swallowed the abort (fleet #2121). The vendor
// supports page/outputsize with a key, and `count` stays the TOTAL matched, so
// we page by default and say so in the payload.
const REF_DEFAULT_OUTPUTSIZE = 200;
const REF_PAGE = { type: 'number' as const, description: 'Page of the reference list (default 1). `count` in the response is the TOTAL matched; `data` is this page.' };
const REF_OUTPUTSIZE = { type: 'number' as const, description: `Rows per page (default ${REF_DEFAULT_OUTPUTSIZE}, max 5000). The unfiltered ETF list is 64,000+ rows, so narrow with symbol / country / exchange rather than raising this.` };
const REF_COUNTRY = { type: 'string' as const, description: 'Optional country filter — full name or alpha code (e.g. "Japan", "Germany", "United States", "US").' };
const MIC_CODE = { type: 'string' as const, description: 'Optional ISO 10383 market identifier code filter (e.g. "XNAS", "XLON").' };

const tools: McpToolExport['tools'] = [
  {
    name: 'time_series',
    description:
      'Twelve Data OHLC time series for a stock, forex, crypto, or ETF symbol. Requires symbol and interval (e.g. \'1min\', \'1h\', \'1day\'). Returns timestamped open/high/low/close + volume.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, interval: INTERVAL, outputsize: OUTPUTSIZE, exchange: EXCHANGE, start_date: START_DATE, end_date: END_DATE, order: ORDER, timezone: TIMEZONE },
      required: ['symbol', 'interval'],
    },
  },
  {
    name: 'quote',
    description: 'Twelve Data real-time quote snapshot for a symbol: open, high, low, close, volume, 52-week range, exchange, currency. Use for a full current-day market snapshot.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, interval: INTERVAL, exchange: EXCHANGE, timezone: TIMEZONE },
      required: ['symbol'],
    },
  },
  {
    name: 'price',
    description: 'Twelve Data latest trade price for a single symbol (stock, forex, crypto, ETF). Returns a single numeric price field. Lightest endpoint for current-price lookups.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, exchange: EXCHANGE }, required: ['symbol'] },
  },
  {
    name: 'eod',
    description: 'Twelve Data end-of-day closing quote for a symbol. Returns the last closing price, volume, and date. Use for daily settlement prices rather than intraday data.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, exchange: EXCHANGE }, required: ['symbol'] },
  },
  {
    name: 'exchange_rate',
    description: 'Twelve Data live forex exchange rate for a currency pair symbol (e.g. \'EUR/USD\'). Optional dp (decimal places) and timezone. Returns rate, timestamp, and pair identifiers.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, format: { type: 'string', description: 'Response format: "JSON" (default) or "CSV".' }, dp: { type: 'number', description: 'Decimal places for the rate (0–11).' }, timezone: TIMEZONE },
      required: ['symbol'],
    },
  },
  {
    name: 'currency_conversion',
    description: 'Twelve Data real-time currency conversion: pass a forex pair symbol (e.g. \'EUR/USD\') and an amount to get the converted value at the current exchange rate.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, amount: { type: 'number', description: 'Amount in the base currency to convert.' }, format: { type: 'string', description: 'Response format: "JSON" (default) or "CSV".' }, dp: { type: 'number', description: 'Decimal places (0–11).' } },
      required: ['symbol', 'amount'],
    },
  },
  {
    name: 'stocks',
    description: 'Twelve Data reference list of all supported stock symbols with exchange and country metadata. Use to discover or validate tickers before querying price endpoints.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Optional ticker filter (e.g. "AAPL").' }, exchange: EXCHANGE, country: { type: 'string', description: 'Optional country filter (e.g. "United States").' }, type: { type: 'string', description: 'Optional instrument type filter (e.g. "Common Stock").' } },
    },
  },
  {
    name: 'forex_pairs',
    description: 'Twelve Data reference list of all supported forex currency pairs (e.g. EUR/USD). Use to enumerate or validate pair symbols before querying exchange_rate or time_series.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Optional pair filter (e.g. "EUR/USD").' }, currency_base: { type: 'string', description: 'Optional base currency (e.g. "EUR").' }, currency_quote: { type: 'string', description: 'Optional quote currency (e.g. "USD").' } },
    },
  },
  {
    name: 'cryptocurrencies',
    description: 'Twelve Data reference list of all supported cryptocurrency symbols with exchange metadata. Use to discover or validate crypto tickers before querying price endpoints.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Optional pair filter (e.g. "BTC/USD").' }, exchange: EXCHANGE },
    },
  },
  {
    name: 'etfs',
    description:
      'Twelve Data reference list of supported ETF symbols (64,000+ listings worldwide) with exchange and country metadata — paged, default 200 rows, `count` is the total matched. Filter by symbol (e.g. "SPY"), country or exchange. Use to discover or validate ETF tickers before querying price endpoints. A stock ticker (e.g. "AAPL") is not an ETF and returns an empty list with `empty_reason: wrong_instrument_class` — use the stocks tool for those.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional ETF ticker filter (e.g. "SPY", "QQQ", "VTI").' },
        exchange: EXCHANGE,
        mic_code: MIC_CODE,
        country: REF_COUNTRY,
        page: REF_PAGE,
        outputsize: REF_OUTPUTSIZE,
      },
    },
  },
  {
    name: 'indices',
    description:
      'Twelve Data reference list of supported market index symbols with exchange metadata — about 1,300 NON-US indices (e.g. N225 Nikkei 225, 000001 SSE Composite, NSEI Nifty 50), paged, default 200 rows. Filter by country (e.g. "Japan", "India", "China"), exchange or symbol. US indices (SPX, DJI, IXIC, NDX, VIX) are NOT in Twelve Data\'s reference list and quoting them requires a Grow-or-higher Twelve Data key via _apiKey — a US filter here returns that refusal, not an empty list. Use to discover or validate index tickers before querying time_series.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional index symbol filter (e.g. "N225", "NSEI", "000001"). US symbols such as SPX/DJI/IXIC are not in this list — see the tool description.' },
        country: { type: 'string', description: 'Optional country filter, full name or alpha code (e.g. "Japan", "India", "China", "Germany"). "United States" returns a plan refusal, not rows.' },
        exchange: EXCHANGE,
        mic_code: MIC_CODE,
        page: REF_PAGE,
        outputsize: REF_OUTPUTSIZE,
      },
    },
  },
  {
    name: 'earnings',
    description: 'Twelve Data earnings history and upcoming earnings dates for a stock symbol: EPS estimate, EPS actual, surprise percentage, and report date per quarter.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, exchange: EXCHANGE, start_date: START_DATE, end_date: END_DATE },
      required: ['symbol'],
    },
  },
  {
    name: 'earnings_calendar',
    description: 'Twelve Data broad earnings calendar — upcoming and recent earnings announcements across all covered symbols. Returns symbol, date, EPS estimate, and time of day (before/after market).',
    inputSchema: { type: 'object', properties: { start_date: START_DATE, end_date: END_DATE } },
  },
  {
    name: 'dividends',
    description: 'Twelve Data historical dividends for a stock / ETF symbol: ex-date, amount, frequency. Use for income analysis and dividend-capture strategies on Twelve-Data-covered symbols.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, exchange: EXCHANGE, start_date: START_DATE, end_date: END_DATE },
      required: ['symbol'],
    },
  },
  {
    name: 'splits',
    description: 'Twelve Data historical stock splits for a symbol: ratio, date. Use to adjust historical Twelve Data prices across split events.',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, exchange: EXCHANGE, start_date: START_DATE, end_date: END_DATE },
      required: ['symbol'],
    },
  },
  {
    name: 'profile',
    description: 'Twelve Data company profile for a stock symbol: name, sector, industry, employees, CEO, description, website, address, and exchange listing details.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, exchange: EXCHANGE }, required: ['symbol'] },
  },
  {
    name: 'technical_indicator',
    description:
      'Compute a technical indicator time series for a stock/forex/crypto symbol via Twelve Data — RSI, SMA, EMA, MACD, Bollinger Bands (bbands), ADX, ATR, Stochastic, CCI, and more. PREFER for "RSI(14) of AAPL", "50-day and 200-day SMA of TSLA", "MACD for BTC/USD", "Bollinger Bands of SPY". This is the right tool for ANY "RSI / SMA / EMA / MACD / moving average / technical indicator for <ticker>" question. Computes ONE indicator per call: if several are requested (e.g. "RSI and the 50-day and 200-day SMA"), call this once per indicator starting with the first — do NOT decline just because multiple indicators are asked for. Returns dated indicator values.',
    inputSchema: {
      type: 'object',
      properties: {
        indicator: {
          type: 'string',
          description: 'Indicator (lowercase): rsi, sma, ema, wma, dema, tema, macd, bbands, stoch, stochrsi, adx, atr, natr, cci, mom, roc, willr, obv, ad, vwap, aroon, mfi, sar, trix, ppo, kama.',
        },
        symbol: SYMBOL,
        interval: INTERVAL,
        time_period: { type: 'number', description: 'Look-back period in bars (e.g. 14 for RSI, 50 or 200 for SMA, 20 for bbands). Default varies by indicator.' },
        series_type: { type: 'string', description: 'Price series the indicator is computed on: close (default), open, high, low.' },
        outputsize: OUTPUTSIZE,
      },
      required: ['indicator', 'symbol', 'interval'],
    },
  },
];

// Allowlisted Twelve Data indicator endpoints (the `indicator` arg becomes the URL
// path, so it must be validated — never pass arbitrary user input into the path).
const ALLOWED_INDICATORS = new Set([
  'rsi', 'sma', 'ema', 'wma', 'dema', 'tema', 'macd', 'bbands', 'stoch', 'stochrsi',
  'adx', 'atr', 'natr', 'cci', 'mom', 'roc', 'rocp', 'willr', 'obv', 'ad', 'adosc',
  'vwap', 'aroon', 'aroonosc', 'mfi', 'sar', 'trix', 'ultosc', 'ppo', 'kama',
  'plus_di', 'minus_di',
]);

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) throw new Error('Twelve Data requires an API key: pass your key as the _apiKey argument (free at https://twelvedata.com/register).');
  const get = async (path: string, params: Record<string, unknown>) => {
    const p = new URLSearchParams({ apikey: apiKey });
    for (const [k, v] of Object.entries(params)) if (k !== '_apiKey' && v != null) p.set(k, String(v));
    const res = await pwFetch(`${BASE}${path}?${p}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    // Twelve Data answers a bad request with HTTP 400 AND a JSON body that says
    // exactly what was wrong ("The precision should be in range [0,11]", or that
    // `symbol` must be a pair). We used to throw on the status BEFORE reading the
    // body, so every one of those became a bare "Twelve Data: 400" and the
    // `j.status === 'error'` branch below was dead code for any non-200. Callers
    // passing `symbol: "EUR"` instead of "EUR/USD" were told nothing they could
    // act on, which is why exchange_rate and currency_conversion went 23 calls
    // with zero successes: the information needed to self-correct existed in the
    // response and we threw it away.
    // Read the body as TEXT, then parse — two failures that used to share one
    // message. `res.json().catch(() => null)` turned an AbortError thrown while
    // streaming a 17 MB reference list (the 25s fetchWithTimeout signal covers
    // the body read too) into "200 response was not JSON", which sent the
    // reader hunting for a malformed vendor payload that did not exist
    // (fleet #2121, 2026-09-16: the same call parsed fine at 5.1s upstream).
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // err.name is a fixed JS Error name (AbortError, TypeError, …), never a
      // routing token — this pack never sets a custom .name — but the gate
      // can't tell that statically, so drop is a documented no-op here rather
      // than a real defect (checked: `upstream_down:` is already at position 0).
      const name = err instanceof Error ? err.name : 'Error';
      throw new Error(
        `upstream_down: Twelve Data answered HTTP ${res.status} but the response body could not be read in full (${dropClassPrefix(name)}) — ` +
          `the payload is too large or too slow for this request. Narrow it (symbol / country / exchange) or lower outputsize, then retry.`,
      );
    }
    let body: { status?: string; code?: number; message?: string } | null = null;
    try {
      body = text ? (JSON.parse(text) as { status?: string; code?: number; message?: string }) : null;
    } catch {
      body = null;
    }
    const upstreamMsg = body?.message?.trim();
    // Plan gates before anything else. Twelve Data phrases them two ways
    // ("/earnings is available exclusively with grow or pro or ultra … plans",
    // "This symbol is available starting with the Pro or Venture plan") and both
    // end with the same pricing-page pointer. These were classed user_error,
    // which reads as "the caller asked wrong" when the truth is "this needs a
    // plan our shared key does not have" — a gate nobody sees never gets
    // provisioned. The wording must say the endpoint requires a key on a named
    // plan (and _apiKey is what routes it to auth_required).
    if (upstreamMsg && /twelvedata\.com\/pricing|available (?:exclusively|starting) with/i.test(upstreamMsg)) {
      throw new Error(`Twelve Data: this endpoint requires an API key on a paid Twelve Data plan — the platform's shared key does not include it. If you have a Grow/Pro/Ultra (or higher) Twelve Data key, pass it via the _apiKey argument. Upstream: ${upstreamMsg}`);
    }
    if (res.status === 401 || (res.status === 403 && !upstreamMsg)) {
      throw new Error('Twelve Data: invalid API key.');
    }
    // A 403 WITH a message is Twelve Data's plan gate, not a bad key — the same
    // key works on the endpoints our plan includes. Saying "invalid API key"
    // there sent us looking for a key problem that did not exist.
    if (res.status === 403) throw new Error(`user_error: Twelve Data: ${upstreamMsg} (this endpoint is not included in the current Twelve Data plan)`);
    if (!res.ok) {
      throw new Error(`user_error: Twelve Data: ${res.status}${upstreamMsg ? ` — ${upstreamMsg}` : ''}`);
    }
    if (body?.status === 'error') throw new Error(`user_error: Twelve Data: ${body.code} ${upstreamMsg ?? ''}`);
    // A 200 we couldn't parse is a real defect, not an empty result — throw rather
    // than returning null, so it lands in the error class instead of counting as a
    // successful call nobody can see.
    if (body == null) {
      throw new Error(`Twelve Data: ${res.status} response was not JSON (${text.length} bytes, starts: ${JSON.stringify(text.slice(0, 80))})`);
    }
    return body;
  };
  // ── Reference lists: paged, and honest about WHY a filter matched nothing ──
  type RefRow = Record<string, unknown>;
  type RefBody = { data?: RefRow[]; count?: number; status?: string };
  const refList = async (path: string, params: Record<string, unknown>) => {
    const page = Math.max(1, Number(params.page) || 1);
    const outputsize = Math.min(5000, Math.max(1, Number(params.outputsize) || REF_DEFAULT_OUTPUTSIZE));
    // The vendor's `page` is ZERO-BASED, whatever its docs say: the offset it
    // applies is page * outputsize, and omitting `page` behaves as page 0.
    // Measured live through the gateway on 2026-09-16 with stocks?symbol=AAPL
    // (count 12): page=0 & outputsize=3 -> BVC, BVL, VSE; no page -> the same
    // three; page=2 -> GPW, IEX, SIX (rows 7-9). And on /etf?symbol=SPY (count 5):
    // page=1 with outputsize 2 -> 2 rows, 4 -> 1 row, 5 -> 0 rows — i.e. the
    // rows AFTER the first `outputsize`. The first cut of this paging sent page=1
    // by default and so silently skipped the first 200 rows of every filtered
    // list: indices {"country":"Japan"} (count 1) and etfs {"symbol":"SPY"}
    // (count 5) came back {"data":[],"count":N} for ~35 minutes on 2026-09-16.
    // Our `page` stays 1-based for callers; only the wire value is shifted.
    const body = (await get(path, { ...params, page: page - 1, outputsize })) as RefBody;
    const data = Array.isArray(body.data) ? body.data : [];
    // With page/outputsize the vendor keeps `count` as the TOTAL matched (verified
    // 2026-09-16: country=United States, outputsize=3 -> count 11345, 3 rows).
    const total = typeof body.count === 'number' ? body.count : data.length;
    const from = (page - 1) * outputsize;
    const out: RefBody & { returned: number; page: number; outputsize: number; truncated: boolean; hint?: string } = {
      ...body,
      data,
      count: total,
      returned: data.length,
      page,
      outputsize,
      truncated: from + data.length < total,
    };
    if (data.length === 0 && total > 0) {
      // An empty page with a non-zero total is a page past the end (or the
      // vendor skipping rows again). Say that; never "Showing rows 1–0 of 1".
      out.truncated = false;
      out.hint = `page=${page} is past the end: only ${total} rows match (${Math.ceil(total / outputsize)} page(s) of ${outputsize}).`;
    } else if (out.truncated) {
      out.hint = `Showing rows ${from + 1}–${from + data.length} of ${total}. Pass page=${page + 1} for the next page, or narrow with symbol / country / exchange.`;
    }
    return out;
  };

  // A symbol that matched nothing in a reference list is usually the RIGHT
  // ticker for the WRONG instrument class — 41 distinct callers sent "AAPL" to
  // the ETF list in the 30d to 2026-09-16 and every one got a bare []. Ask
  // symbol_search (one extra call, only on the empty path) what the symbol IS,
  // and say so via the gateway's `empty_reason` passthrough (fleet #2112).
  const instrumentHint = async (symbol: string, wanted: 'ETF' | 'Index', listTool: string): Promise<{ empty_reason: string; hint: string } | null> => {
    try {
      const s = (await get('/symbol_search', { symbol, outputsize: 30 })) as { data?: Array<{ symbol?: string; instrument_name?: string; instrument_type?: string; exchange?: string; country?: string }> };
      const exact = (s.data ?? []).filter((r) => String(r.symbol ?? '').toUpperCase() === symbol.toUpperCase());
      const types = [...new Set(exact.map((r) => r.instrument_type ?? 'unknown'))];
      if (exact.length === 0) {
        return { empty_reason: 'no_match', hint: `"${symbol}" matches no instrument of any class on Twelve Data (symbol_search found nothing). Check the ticker.` };
      }
      if (!types.includes(wanted)) {
        const first = exact[0];
        const next = types.includes('Common Stock') || types.includes('Depositary Receipt') ? 'the stocks tool to validate it, then quote / price / time_series' : 'quote or time_series';
        return {
          empty_reason: 'wrong_instrument_class',
          hint: `"${symbol}" is not an ${wanted} on Twelve Data — it is ${types.join(' / ')} (${first.instrument_name ?? '?'}, ${first.exchange ?? '?'}). The ${listTool} tool lists ${wanted === 'ETF' ? 'ETFs' : 'indices'} only; use ${next} with this symbol.`,
        };
      }
    } catch {
      /* the hint is best-effort; the empty result stands on its own */
    }
    return null;
  };

  // US market indices are NOT in Twelve Data's /indices reference list — 1,302
  // rows, zero with country "United States", identical with and without a key
  // (checked 2026-09-16, so this is the vendor's catalogue, not our plan hiding
  // rows). Quoting them is a plan wall: quote SPX on the shared key answers
  // "This symbol is available starting with the Grow or Venture plan". 34
  // distinct callers followed our own "United States" example into a clean
  // empty (fleet #2120). Say the true thing instead — and only when the list
  // really came back empty, so if the vendor ever re-adds US rows this path
  // stops firing on its own.
  const US_COUNTRY = /^(united states|united states of america|usa|us|u\.s\.a?\.?|america)$/i;
  const US_EXCHANGE = /^(nyse|nasdaq|cboe|amex|nyse arca|arca|nyse american)$/i;
  const US_MIC = new Set(['XNYS', 'XNAS', 'XNGS', 'XNMS', 'XNCM', 'XCBO', 'ARCX', 'XASE', 'BATS', 'IEXG']);
  const US_INDEX_SYMBOLS = new Set(['SPX', 'GSPC', 'SP500', 'DJI', 'DJIA', 'IXIC', 'COMP', 'NDX', 'RUT', 'VIX', 'OEX', 'MID', 'SML', 'NYA', 'XAX', 'W5000', 'DJT', 'DJU', 'SOX', 'RUA']);
  const isUsIndexQuery = (a: Record<string, unknown>) =>
    US_COUNTRY.test(String(a.country ?? '').trim()) ||
    US_EXCHANGE.test(String(a.exchange ?? '').trim()) ||
    US_MIC.has(String(a.mic_code ?? '').trim().toUpperCase()) ||
    US_INDEX_SYMBOLS.has(String(a.symbol ?? '').trim().toUpperCase().replace(/^[\^.]/, ''));
  const US_INDICES_REFUSAL =
    "Twelve Data: US market indices (SPX, DJI, IXIC, NDX, RUT, VIX) are not in Twelve Data's /indices reference list — it carries ~1,300 non-US indices and zero US rows, with or without a key — and quoting them requires an API key on a paid Twelve Data plan (Grow or higher); the platform's shared key does not include them. " +
    'Vendor message for quote SPX: "This symbol is available starting with the Grow or Venture plan. Consider upgrading now at https://twelvedata.com/pricing". ' +
    'If you have a Grow/Pro/Ultra Twelve Data key, pass it via the _apiKey argument and call quote or time_series with symbol "SPX" directly — do not use this list to validate it first. ' +
    'For non-US indices this tool works as documented: try country "Japan", "India" or "China".';

  switch (name) {
    case 'etfs': {
      const out = await refList('/etf', args);
      const symbol = String(args.symbol ?? '').trim();
      if (out.returned === 0 && out.count === 0 && symbol) {
        const why = await instrumentHint(symbol, 'ETF', 'etfs');
        if (why) return { ...out, ...why };
      }
      return out;
    }
    case 'indices': {
      const out = await refList('/indices', args);
      if (out.returned === 0 && out.count === 0 && isUsIndexQuery(args)) throw new Error(US_INDICES_REFUSAL);
      const symbol = String(args.symbol ?? '').trim();
      if (out.returned === 0 && out.count === 0 && symbol) {
        const why = await instrumentHint(symbol, 'Index', 'indices');
        if (why) return { ...out, ...why };
      }
      return out;
    }
    case 'technical_indicator': {
      const indicator = String(args.indicator ?? '').toLowerCase().trim();
      if (!ALLOWED_INDICATORS.has(indicator)) {
        throw new Error(`Unsupported indicator "${indicator}". Allowed: ${[...ALLOWED_INDICATORS].join(', ')}.`);
      }
      const { indicator: _drop, ...rest } = args;
      return get(`/${indicator}`, rest);
    }
    case 'time_series':
      return get('/time_series', args);
    case 'quote':
      return get('/quote', args);
    case 'price':
      return get('/price', args);
    case 'eod':
      return get('/eod', args);
    case 'exchange_rate':
      return get('/exchange_rate', args);
    case 'currency_conversion':
      return get('/currency_conversion', args);
    case 'stocks':
      return get('/stocks', args);
    case 'forex_pairs':
      return get('/forex_pairs', args);
    case 'cryptocurrencies':
      return get('/cryptocurrencies', args);
    case 'earnings':
      return get('/earnings', args);
    case 'earnings_calendar':
      return get('/earnings_calendar', args);
    case 'dividends':
      return get('/dividends', args);
    case 'splits':
      return get('/splits', args);
    case 'profile':
      return get('/profile', args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
