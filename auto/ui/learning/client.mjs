// T22: shared learning API client (CONTRACTS G). One module every learning
// view uses for paginated GETs, CSRF-protected POSTs, request cancellation
// and typed error states. Pure browser ESM with an injectable fetch so the
// node:test suite exercises it without a DOM or a server.
//
// Consequential-POST rule: a POST whose outcome is unknown (network failure
// mid-flight) is NEVER silently retried — it surfaces as kind
// 'unknown_result' and the caller must re-read server state. The only
// automatic retry is a CSRF 403, which the server rejects BEFORE executing
// anything (a known non-executed result), after refreshing the token once.

export const API_BASE = '/api/auto/learning';
export const PANEL_BASE = '/api/auto';

/** Typed error for every client failure. `kind` is one of:
 *  network | unknown_result | forbidden | csrf | not_found | stale |
 *  conflict | invalid | too_large | unsupported | corrupt | server |
 *  cancelled | disabled */
export class LearningClientError extends Error {
  constructor(kind, message, { status = null, code = null, body = null, unknownResult = false } = {}) {
    super(message);
    this.name = 'LearningClientError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.body = body;
    // true only when a consequential POST may or may not have executed.
    this.unknownResult = unknownResult;
  }
}

/** Map an HTTP status + parsed body to a typed error kind. */
export function classifyStatus(status, body = null) {
  const code = body && typeof body === 'object' ? body.code ?? null : null;
  if (status === 403) return code === 'CSRF' ? 'csrf' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 405) return 'invalid';
  if (status === 409) return code === 'REFRESH_REQUIRED' ? 'stale' : 'conflict';
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported';
  if (status === 422) return 'invalid';
  if (status === 500 && code === 'CORRUPT_RECORD') return 'corrupt';
  return 'server';
}

function errorFrom(status, body) {
  const kind = classifyStatus(status, body);
  const msg = (body && typeof body === 'object' && typeof body.error === 'string')
    ? body.error : `request failed (${status})`;
  return new LearningClientError(kind, msg, {
    status, code: body && typeof body === 'object' ? body.code ?? null : null, body,
  });
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

/**
 * createLearningClient({base, panelBase, fetchImpl}) -> client.
 * All methods throw LearningClientError on failure; GETs are cancellable via
 * named keys (a new request with the same key aborts the previous one).
 */
export function createLearningClient({ base = API_BASE, panelBase = PANEL_BASE, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let csrfToken = null;
  const inflight = new Map();

  function keyedSignal(key, external) {
    if (!key) return external ?? null;
    const prev = inflight.get(key);
    if (prev) prev.abort();
    const ctrl = new AbortController();
    inflight.set(key, ctrl);
    if (external) external.addEventListener?.('abort', () => ctrl.abort(), { once: true });
    return ctrl.signal;
  }

  async function getJson(url, { key = null, signal = null } = {}) {
    const sig = keyedSignal(key, signal);
    let res;
    try {
      res = await doFetch(url, { method: 'GET', signal: sig ?? undefined });
    } catch (err) {
      if (isAbort(err)) throw new LearningClientError('cancelled', 'request cancelled');
      throw new LearningClientError('network', `network failure: ${err?.message ?? err}`);
    }
    const body = await parseBody(res);
    if (!res.ok) throw errorFrom(res.status, body);
    return body;
  }

  async function status(opts = {}) {
    const payload = await getJson(`${base}/status`, opts);
    if (payload && typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
    return payload;
  }

  function listUrl(route, params = {}) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    }
    const qs = u.toString();
    return `${base}/${route}${qs ? `?${qs}` : ''}`;
  }

  /** One page of a list route; returns the raw envelope. */
  function list(route, { params = {}, key = null, signal = null } = {}) {
    return getJson(listUrl(route, params), { key, signal });
  }

  /**
   * All pages of a list route under ONE generation. A stale cursor (409
   * REFRESH_REQUIRED) or a generation change mid-walk restarts the walk once
   * from the beginning; a second staleness surfaces as kind 'stale'.
   */
  async function listAll(route, { params = {}, pageLimit = 100, maxPages = 50, key = null, signal = null, onPage = null } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const items = [];
      let cursor = null;
      let generation = null;
      let coverage = null;
      let feature = null;
      let stale = false;
      for (let page = 0; page < maxPages; page += 1) {
        let envelope;
        try {
          envelope = await list(route, {
            params: { ...params, limit: pageLimit, ...(cursor ? { cursor } : {}) },
            key: key ? `${key}:page` : null, signal,
          });
        } catch (err) {
          if (err instanceof LearningClientError && err.kind === 'stale' && attempt === 0) { stale = true; break; }
          throw err;
        }
        feature = envelope.feature ?? feature;
        coverage = envelope.coverage ?? coverage;
        if (generation == null) generation = envelope.generation;
        else if (envelope.generation !== generation) { stale = true; break; }
        items.push(...(envelope.items ?? []));
        onPage?.(envelope);
        cursor = envelope.nextCursor ?? null;
        if (!cursor) return { items, generation, coverage, feature };
      }
      if (!stale) return { items, generation, coverage, feature };
    }
    throw new LearningClientError('stale', `list ${route}: records changed twice during pagination — refresh and retry`, { code: 'REFRESH_REQUIRED' });
  }

  /**
   * Consequential POST. Requires the CSRF token (fetched via GET /status when
   * missing). A CSRF 403 refreshes the token and retries ONCE — the server
   * rejects CSRF before executing, so the result of the first call is a known
   * no-op. A network failure after send is kind 'unknown_result' and is never
   * retried here: the caller must re-read server state.
   */
  async function post(route, payload, { signal = null } = {}) {
    if (!csrfToken) await status();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res;
      try {
        res = await doFetch(`${base}/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-learning-csrf': csrfToken },
          body: JSON.stringify(payload ?? {}),
          signal: signal ?? undefined,
        });
      } catch (err) {
        if (isAbort(err)) throw new LearningClientError('cancelled', 'request cancelled');
        throw new LearningClientError('unknown_result',
          `POST ${route} failed in flight — the operation MAY have executed; re-read server state before retrying (${err?.message ?? err})`,
          { unknownResult: true });
      }
      const body = await parseBody(res);
      if (res.ok) return body;
      const err = errorFrom(res.status, body);
      if (err.kind === 'csrf' && attempt === 0) { await status(); continue; }
      throw err;
    }
    throw new LearningClientError('server', `POST ${route}: unreachable retry state`);
  }

  /** Panel (non-learning) GET helper for jobs + queue preview. */
  function panelGet(route, { key = null, signal = null } = {}) {
    return getJson(`${panelBase}/${route}`, { key, signal });
  }

  function cancel(key) { inflight.get(key)?.abort(); inflight.delete(key); }
  function cancelAll() { for (const c of inflight.values()) c.abort(); inflight.clear(); }

  return {
    status, list, listAll, post, panelGet, cancel, cancelAll,
    get csrfToken() { return csrfToken; },
  };
}
