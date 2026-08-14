/**
 * nsds-api — a CORS shim for the two APIs the site reads.
 *
 * Neither Luma nor Instagram will talk to a browser on our origin. Luma keeps
 * an explicit allowlist and reflects back only its own domains:
 *
 *   Origin: https://luma.com              -> access-control-allow-origin: https://luma.com
 *   Origin: https://notsodailystandup.com -> (nothing)
 *
 * and Instagram's profile endpoint only answers when the request carries a
 * `referer` of the profile page — a header the fetch spec forbids page scripts
 * from setting. Both calls therefore have to happen off-browser. This Worker is
 * the smallest thing that can make them: it forwards the request, adds the
 * CORS header, and caches the answer at the edge so we aren't hammering either
 * API once per visitor.
 *
 * Deploy:  npx wrangler deploy
 * Local:   npx wrangler dev
 */

const LUMA_USER = 'usr-5IoinAmtej3Z8xe'; // luma.com/user/TechComedyShow
const IG_USER = 'notsodailystandup';
// Public web client id Instagram's own site sends. Not a secret and not tied
// to an account — it just makes the endpoint answer with JSON instead of HTML.
const IG_APP_ID = '936619743392459';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Who may call this Worker. Anything else gets no CORS header and so is
// refused by the caller's browser — this is a shim for our own site, not an
// open proxy for the whole internet.
const ALLOWED = [
  'https://notsodailystandup.com',
  'https://www.notsodailystandup.com',
  'https://desitrain22.github.io',
];

// Edge cache lifetimes. Shows move on the order of weeks, so a few minutes of
// staleness is invisible to a visitor but collapses a burst of traffic into a
// single upstream call.
const TTL = { luma: 300, instagram: 900 };

function cors(origin) {
  const headers = { 'access-control-allow-origin': '', vary: 'Origin' };
  // localhost on any port, for `wrangler dev` and `npm run dev`.
  const ok = ALLOWED.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || '');
  if (ok) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(body, origin, { status = 200, ttl = 0 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
      ...cors(origin),
    },
  });
}

/** Luma's public profile feed. `period` is 'future' or 'past'. */
async function luma(period) {
  const url =
    'https://api.lu.ma/user/profile/events-hosting' +
    `?user_api_id=${LUMA_USER}&period=${period}&pagination_limit=50`;

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    cf: { cacheTtl: TTL.luma, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`luma ${period}: HTTP ${res.status}`);

  const body = await res.json();
  const entries = Array.isArray(body?.entries) ? body.entries : [];

  return entries
    .map(({ event: e, guest_count }) => {
      if (!e?.api_id) return null;
      const geo = e.geo_address_info || {};
      return {
        id: e.api_id,
        name: e.name,
        // `url` is the vanity slug, not a full URL.
        link: `https://luma.com/${e.url}`,
        embed: `https://luma.com/embed/event/${e.api_id}/simple`,
        startAt: e.start_at,
        timezone: e.timezone,
        city: geo.city_state || geo.city || '',
        venue: geo.name || geo.address || '',
        cover: e.cover_url || '',
        guests: typeof guest_count === 'number' ? guest_count : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

/**
 * Instagram returns pinned posts first, then reverse-chronological — which is
 * the order we want, so the head of the feed is taken as-is.
 */
// Hosts /thumb will re-serve. Instagram's CDN sends
// `Cross-Origin-Resource-Policy: same-origin`, so a browser refuses to paint
// those URLs in an <img> on our page even though the bytes are public. The
// Worker refetches them and drops that header. Kept to an allowlist so this
// stays a thumbnail shim and not an open image proxy.
const THUMB_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

async function instagram(limit, self) {
  const res = await fetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${IG_USER}`,
    {
      headers: {
        'user-agent': UA,
        'x-ig-app-id': IG_APP_ID,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'x-requested-with': 'XMLHttpRequest',
        // The header a page script is not allowed to set. Dropping it brings
        // back a 400.
        referer: `https://www.instagram.com/${IG_USER}/`,
      },
      cf: { cacheTtl: TTL.instagram, cacheEverything: true },
    },
  );
  if (!res.ok) throw new Error(`instagram: HTTP ${res.status}`);

  const user = (await res.json())?.data?.user;
  if (!user) throw new Error('instagram: unexpected payload');

  const edges = user.edge_owner_to_timeline_media?.edges ?? [];
  return {
    followers: user.edge_followed_by?.count ?? null,
    posts: edges.slice(0, limit).map(({ node: n }) => {
      const raw = n.thumbnail_src || n.display_url || '';
      return {
        shortcode: n.shortcode,
        isVideo: !!n.is_video,
        permalink: `https://www.instagram.com/${n.is_video ? 'reel' : 'p'}/${n.shortcode}/`,
        embed: `https://www.instagram.com/${n.is_video ? 'reel' : 'p'}/${n.shortcode}/embed/`,
        caption: (n.edge_media_to_caption?.edges?.[0]?.node?.text ?? '').trim(),
        takenAt: new Date(n.taken_at_timestamp * 1000).toISOString(),
        // Handed back pointing at our own /thumb, so the page never has to
        // deal with a CDN URL the browser will refuse to render.
        thumb: raw ? `${self}/thumb?u=${encodeURIComponent(raw)}` : '',
      };
    }),
  };
}

/** Re-serve one Instagram CDN image without its restrictive CORP header. */
async function thumb(target, origin) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return new Response('bad url', { status: 400, headers: cors(origin) });
  }
  if (url.protocol !== 'https:' || !THUMB_HOSTS.test(url.hostname)) {
    return new Response('forbidden host', { status: 403, headers: cors(origin) });
  }

  const res = await fetch(url.toString(), {
    headers: { 'user-agent': UA, accept: 'image/*' },
    cf: { cacheTtl: TTL.instagram, cacheEverything: true },
  });
  if (!res.ok) return new Response('upstream error', { status: 502, headers: cors(origin) });

  return new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') || 'image/jpeg',
      'cache-control': `public, max-age=${TTL.instagram}`,
      'cross-origin-resource-policy': 'cross-origin',
      ...cors(origin),
    },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors(origin), 'access-control-max-age': '86400' },
      });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, origin, { status: 405 });
    }

    try {
      if (pathname === '/shows') {
        // Both periods in one round trip — the page needs them together and
        // this halves the request count from the browser.
        const [upcoming, past] = await Promise.all([luma('future'), luma('past')]);
        return json({ upcoming, past }, origin, { ttl: TTL.luma });
      }

      if (pathname === '/instagram') {
        const limit = Math.min(Number(searchParams.get('limit')) || 3, 12);
        const self = new URL(request.url).origin;
        return json(await instagram(limit, self), origin, { ttl: TTL.instagram });
      }

      if (pathname === '/thumb') {
        return thumb(searchParams.get('u') || '', origin);
      }

      return json({ error: 'not found', routes: ['/shows', '/instagram', '/thumb'] }, origin, {
        status: 404,
      });
    } catch (err) {
      // The page falls back to its committed copy on any non-200, so a bad day
      // upstream costs freshness rather than the section.
      return json({ error: String(err.message || err) }, origin, { status: 502 });
    }
  },
};
