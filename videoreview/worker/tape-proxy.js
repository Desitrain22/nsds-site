/**
 * NSDS tape proxy — Cloudflare Worker.
 *
 * WHY THIS EXISTS (measured, not guessed):
 * `drive.usercontent.google.com/download` returns **403 + an HTML error page** to any
 * request carrying `Sec-Fetch-Site: cross-site`. Verified by bisecting headers — that one
 * header alone flips a working `206` into a `403`; User-Agent, Origin and Referer are all
 * fine on their own. `Sec-Fetch-*` is a browser-controlled forbidden header, so JS cannot
 * set or remove it. Consequence: a <video> element on any other origin can NEVER load
 * Drive bytes directly, and the browser reports it as a confusing
 * "MEDIA_ELEMENT_ERROR: Format error" because it got HTML where it wanted an MP4.
 *
 * A server-side fetch sends no `Sec-Fetch-*` headers, so it gets a normal `206`. This
 * Worker is that server-side hop, and it re-serves the bytes with permissive CORS.
 *
 * Verified end-to-end against DavidS_4-23-26.mp4 (4.33 GB, 4K): duration read as 453.82s
 * (exactly matching ffprobe), seeks land precisely, and ranged playback stops within 10ms
 * of the target.
 *
 * DEPLOY: Cloudflare dash -> Workers & Pages -> Create -> paste this file -> Deploy, then
 * Settings -> Variables and Secrets -> add `TAPE_TOKEN`, set to the same phrase the review
 * page asks for. Nothing secret lives in this public repo. Until that secret exists every
 * request gets a 503 by design — this refuses to run as an open proxy.
 */

const DRIVE = id =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`

// Drive file IDs are URL-safe base64-ish. Constrain hard so this can't be pointed at
// arbitrary URLs.
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,80}$/

// Only these come back to the browser. Drive's own CSP, COEP, `cross-origin-resource-policy:
// same-site` and `content-disposition: attachment` are deliberately dropped — the first three
// would block the media load, and the last would try to make it a download.
const PASS_THROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
]

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'Range',
    // Without exposing Content-Range the media element can't learn the total size and
    // will refuse to seek.
    'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

function fail(status, message, origin) {
  return new Response(message, {
    status,
    headers: { ...cors(origin), 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'method not allowed', origin)
  }

  const id = url.searchParams.get('id')
  if (!id) return fail(400, 'missing ?id', origin)
  if (!FILE_ID_RE.test(id)) return fail(400, 'malformed file id', origin)

  // Shared-secret gate, failing CLOSED. `TAPE_TOKEN` is added as a secret *after* the first
  // deploy, so treating "unset" as "allow" would leave a real window where this is an open
  // proxy for every world-readable file on Google Drive, reachable by file id and billed here.
  if (!env.TAPE_TOKEN) {
    return fail(503, 'TAPE_TOKEN is not set on this Worker — add it under ' +
      'Settings -> Variables and Secrets, then retry.', origin)
  }
  if (url.searchParams.get('t') !== env.TAPE_TOKEN) {
    return fail(403, 'bad or missing token', origin)
  }

  const range = request.headers.get('Range')

  // Forward the conditional headers too. Drive sends `last-modified` but no etag, so
  // If-Modified-Since is the only revalidation available — dropping it makes a 304 impossible
  // and pins clients to whatever they cached.
  const upstreamHeaders = {}
  if (range) upstreamHeaders.Range = range
  for (const h of ['If-Modified-Since', 'If-None-Match']) {
    const v = request.headers.get(h)
    if (v) upstreamHeaders[h] = v
  }

  let upstream
  try {
    upstream = await fetch(DRIVE(id), {
      method: request.method === 'HEAD' ? 'GET' : request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
    })
  } catch (err) {
    return fail(502, `upstream fetch failed: ${err.message}`, origin)
  }

  const contentType = upstream.headers.get('content-type') || ''

  // Status first. Drive answers 403 (blocked), 404 (no such file) and 416 (range past EOF)
  // all with an HTML body, so sniffing content-type before status collapses three very
  // different conditions into one misleading "probably not shared" message. 416 in particular
  // is a legitimate, expected response that the media element knows how to handle.
  if (upstream.status === 416) {
    upstream.body?.cancel()
    return new Response(null, {
      status: 416,
      headers: { ...cors(origin), 'content-range': `bytes */${upstream.headers.get('content-length') || '*'}` },
    })
  }
  if (upstream.status === 304) {
    upstream.body?.cancel()
    return new Response(null, { status: 304, headers: cors(origin) })
  }
  if (upstream.status === 403) {
    return fail(502, `Drive refused file ${id} (403). It is probably not shared with ` +
      `"Anyone with the link".`, origin)
  }
  if (upstream.status === 404) {
    return fail(502, `Drive has no file ${id} (404). Check the id.`, origin)
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    return fail(502, `Drive returned ${upstream.status} for ${id}`, origin)
  }
  if (contentType.startsWith('text/html')) {
    return fail(502, `Drive returned HTML instead of media for ${id} (status ` +
      `${upstream.status}). The file may not be shared publicly.`, origin)
  }

  // Drive ignored our Range and sent the whole file. Passing that through means the browser
  // reads and discards from byte 0 — at Drive's throttled rate a seek five minutes in stalls
  // for minutes, indistinguishable from a hang. Better to say so.
  if (range && upstream.status === 200) {
    upstream.body?.cancel()
    return fail(502, `Drive ignored the Range header for ${id} and returned the whole file; ` +
      `refusing to stream it from byte 0.`, origin)
  }

  const headers = new Headers(cors(origin))
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Deliberately NOT manufacturing `accept-ranges: bytes` — claiming range support that the
  // upstream didn't advertise just moves the failure somewhere harder to see.
  //
  // One hour, with revalidation. A `--force` proxy rebuild reuses the same Drive file id, so
  // the URL doesn't change; a long immutable cache would serve stale bytes, and if the rebuilt
  // proxy were shorter the browser's cached content-length would drive a seek past EOF.
  headers.set('cache-control', 'public, max-age=3600, must-revalidate')

  if (request.method === 'HEAD') {
    upstream.body?.cancel()
    return new Response(null, { status: upstream.status, headers })
  }

  return new Response(upstream.body, { status: upstream.status, headers })
}

export default { fetch: handleRequest }
