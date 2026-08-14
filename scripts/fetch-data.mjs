#!/usr/bin/env node
/**
 * Refreshes the data the pages render from:
 *
 *   data/site.js        - upcoming + past Luma shows, recent Instagram posts,
 *                         tallies. Written as `window.NSDS_DATA = {...}` rather
 *                         than JSON so a <script> tag can load it — see main.js.
 *   media/ig/<code>.jpg - Instagram thumbnails, pulled local so we never render a
 *                         signed CDN URL that expires a few weeks later
 *
 * Run by .github/workflows/refresh-data.yml on a cron, and by hand with
 * `npm run fetch`. No dependencies — plain Node 20+ for global fetch.
 *
 * The one rule this script cares about: never make the site worse. Every network
 * hop is allowed to fail, and a failed hop keeps whatever data/site.js already
 * had rather than overwriting it with nothing. A rate-limited Instagram should
 * cost us freshness, not the whole section.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'site.js');
const IG_MEDIA_DIR = path.join(ROOT, 'media', 'ig');

const LUMA_USER = 'usr-5IoinAmtej3Z8xe'; // luma.com/user/TechComedyShow
const IG_USER = 'notsodailystandup';
// Public web client id Instagram's own site sends. Not a secret, not tied to an
// account — it just makes the profile endpoint answer with JSON instead of HTML.
const IG_APP_ID = '936619743392459';

// Long-lived Instagram token, supplied as a repo secret in CI. Optional: with
// it we use the official Graph API, without it we fall back to the endpoint
// instagram.com itself calls. See README for how to mint one.
const IG_TOKEN = process.env.IG_TOKEN || '';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const IG_POST_COUNT = 3;

/** fetch with a timeout and a couple of retries on transient failures. */
async function get(url, { headers = {}, raw = false, tries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, ...headers },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ luma -- */

/**
 * Luma's public profile feed. `period` is 'future' or 'past'; the shape is
 * { entries: [{ event, guest_count, ... }], has_more }.
 */
async function lumaEvents(period) {
  const url =
    `https://api.lu.ma/user/profile/events-hosting` +
    `?user_api_id=${LUMA_USER}&period=${period}&pagination_limit=50`;
  const body = await get(url);
  const entries = Array.isArray(body?.entries) ? body.entries : [];

  return entries
    .map(({ event: e, guest_count }) => {
      if (!e?.api_id) return null;
      const geo = e.geo_address_info || {};
      return {
        id: e.api_id,
        name: e.name,
        // `url` is the vanity slug (e.g. "TechComedyJuly"), not a full URL.
        link: `https://luma.com/${e.url}`,
        embed: `https://luma.com/embed/event/${e.api_id}/simple`,
        startAt: e.start_at,
        endAt: e.end_at,
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

/* ------------------------------------------------------------- instagram -- */

/** The shortcode is the last path segment of a permalink. */
function shortcodeFrom(permalink) {
  const m = /instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/.exec(permalink || '');
  return m ? m[1] : '';
}

/**
 * Official route, used whenever IG_TOKEN is set.
 *
 * This is what makes the scheduled refresh work at all: the unofficial web
 * endpoint below answers fine from a laptop but returns 429 from GitHub's
 * runners, whose datacenter IPs Instagram rate-limits. A token is tied to the
 * account rather than the caller's IP, so it works from anywhere.
 *
 * Trade-off worth knowing: the Graph API has no concept of pinned posts, so
 * this returns the three most recent instead of the three pinned.
 */
async function instagramViaGraph(token) {
  const fields = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp';
  const body = await get(
    `https://graph.instagram.com/me/media?fields=${fields}` +
      `&limit=${IG_POST_COUNT}&access_token=${encodeURIComponent(token)}`,
  );

  const posts = (body?.data ?? [])
    .slice(0, IG_POST_COUNT)
    .map((m) => {
      const isVideo = m.media_type === 'VIDEO';
      return {
        shortcode: shortcodeFrom(m.permalink),
        isVideo,
        permalink: m.permalink,
        embed: `${m.permalink.replace(/\/?$/, '/')}embed/`,
        caption: (m.caption ?? '').trim(),
        takenAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        // Videos expose a still at thumbnail_url; images only have media_url.
        _remoteThumb: m.thumbnail_url || m.media_url || '',
      };
    })
    .filter((p) => p.shortcode);

  if (!posts.length) throw new Error('no media returned');

  // Follower count lives on the account object, not the media edge. It's a
  // nice-to-have, so a failure here shouldn't sink the whole fetch.
  let followers = null;
  try {
    const me = await get(
      `https://graph.instagram.com/me?fields=followers_count&access_token=${encodeURIComponent(token)}`,
      { tries: 1 },
    );
    followers = me?.followers_count ?? null;
  } catch {
    /* older tokens lack this scope — leave the previous number in place */
  }

  return { followers, posts, source: 'graph' };
}

/**
 * Unofficial route: the same endpoint instagram.com calls to render a profile.
 * No token, and it returns pinned posts first — which is the order we want —
 * but Instagram 429s it from datacenter IPs, so in practice this is the local
 * path (`npm run fetch`) rather than the scheduled one.
 */
async function instagramViaWeb() {
  // It 400s unless the request looks like it came from the profile page
  // itself — `referer` is the header it actually checks, the rest round out a
  // plausible XHR. Dropping any of these brings the 400 back.
  const body = await get(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${IG_USER}`,
    {
      headers: {
        'x-ig-app-id': IG_APP_ID,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'x-requested-with': 'XMLHttpRequest',
        referer: `https://www.instagram.com/${IG_USER}/`,
      },
    },
  );

  const user = body?.data?.user;
  if (!user) throw new Error('unexpected payload: no data.user');

  const edges = user.edge_owner_to_timeline_media?.edges ?? [];
  const posts = edges
    .slice(0, IG_POST_COUNT)
    .map(({ node: n }) => ({
      shortcode: n.shortcode,
      isVideo: !!n.is_video,
      permalink: `https://www.instagram.com/${n.is_video ? 'reel' : 'p'}/${n.shortcode}/`,
      embed: `https://www.instagram.com/${n.is_video ? 'reel' : 'p'}/${n.shortcode}/embed/`,
      caption: (n.edge_media_to_caption?.edges?.[0]?.node?.text ?? '').trim(),
      takenAt: new Date(n.taken_at_timestamp * 1000).toISOString(),
      // kept only long enough to download; stripped before we write site.js
      _remoteThumb: n.thumbnail_src || n.display_url || '',
    }))
    .filter((p) => p.shortcode);

  if (!posts.length) throw new Error('no posts in feed');

  return {
    followers: user.edge_followed_by?.count ?? null,
    posts,
    source: 'web',
  };
}

/**
 * Prefer the token when there is one, but still fall back to the web endpoint
 * — that way a missing or newly-expired token degrades to "works on a laptop"
 * instead of "the section stops updating with no explanation".
 */
async function instagramPosts() {
  if (IG_TOKEN) {
    try {
      return await instagramViaGraph(IG_TOKEN);
    } catch (err) {
      console.warn(`  ! graph api: ${err.message} — falling back to web endpoint`);
    }
  }
  return instagramViaWeb();
}

/**
 * Pull each thumbnail into media/ig/. Instagram's CDN URLs carry an expiry
 * signature, so linking them directly means the grid silently goes blank in a
 * few weeks. A thumbnail that fails to download just falls back to no image.
 */
async function localiseThumbs(posts) {
  await mkdir(IG_MEDIA_DIR, { recursive: true });

  for (const post of posts) {
    const rel = `media/ig/${post.shortcode}.jpg`;
    const abs = path.join(ROOT, rel);
    if (post._remoteThumb) {
      try {
        await writeFile(abs, await get(post._remoteThumb, { raw: true }));
      } catch (err) {
        console.warn(`  ! thumbnail ${post.shortcode}: ${err.message}`);
      }
    }
    post.thumb = existsSync(abs) ? rel : '';
    delete post._remoteThumb;
  }
  return posts;
}

/* ------------------------------------------------------------------ main -- */

async function readExisting() {
  try {
    // Pull the object back out of `window.NSDS_DATA = {...};`.
    const src = await readFile(DATA_FILE, 'utf8');
    const start = src.indexOf('{');
    const end = src.lastIndexOf('}');
    if (start === -1 || end === -1) return {};
    return JSON.parse(src.slice(start, end + 1));
  } catch {
    return {};
  }
}

const previous = await readExisting();
const next = { ...previous, generatedAt: new Date().toISOString() };
const failures = [];

// Luma. Upcoming and past are fetched independently so a blip on one doesn't
// take out the other.
for (const [period, key] of [
  ['future', 'upcoming'],
  ['past', 'past'],
]) {
  try {
    const events = await lumaEvents(period);
    next[key] = events;
    console.log(`luma ${period}: ${events.length} event(s)`);
  } catch (err) {
    failures.push(`luma/${period}: ${err.message}`);
    console.warn(`luma ${period} FAILED (${err.message}) — keeping previous`);
  }
}

// An empty `upcoming` is a legitimate answer, not a failure: between shows,
// there genuinely is nothing scheduled. The page has a state for that.

try {
  const { followers, posts, source } = await instagramPosts();
  next.instagram = await localiseThumbs(posts);
  if (followers) next.followers = followers;
  console.log(
    `instagram: ${posts.length} post(s), ${followers ?? '?'} followers (via ${source})`,
  );
} catch (err) {
  failures.push(`instagram: ${err.message}`);
  console.warn(`instagram FAILED (${err.message}) — keeping previous`);
}

// The hero loop is optional. Detecting it here — where we can just look at the
// filesystem — means the page never has to probe for it over the network and
// eat a 404 on every visit when it isn't there. Drop media/hero.mp4 in and the
// next refresh turns it on by itself.
next.heroVideo = existsSync(path.join(ROOT, 'media', 'hero.mp4')) ? 'media/hero.mp4' : null;

/**
 * Luma stores whatever the organiser typed, so the same place arrives spelled
 * several ways — "New York, New York" and "New York, NY" are both in the feed
 * today. De-duping the raw strings counted that city twice. Compare on the
 * locality alone, normalized.
 */
function cityKey(value) {
  return value
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ');
}

// Headline tallies, derived from whatever we ended up with.
const past = next.past ?? [];
next.stats = {
  // Labelled "Shows produced" on the page, so count only the ones that have
  // actually happened — an announced date isn't a produced show.
  shows: past.length,
  attendees: past.reduce((sum, e) => sum + (e.guests || 0), 0),
  cities: new Set(past.map((e) => e.city).filter(Boolean).map(cityKey)).size,
};

// `generatedAt` moves on every run, so comparing the full payload would report
// a change every time and the cron would commit noise six times a day. Compare
// everything else, and only touch the file when a visitor would see a
// difference — that keeps the workflow's commit step a plain `git diff`.
const meaningful = (obj) => {
  const { generatedAt, ...rest } = obj;
  return JSON.stringify(rest);
};

if (meaningful(previous) === meaningful(next)) {
  console.log('\nno change — leaving data/site.js alone');
} else {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });

  // A script that assigns a global, rather than a .json the page would have to
  // fetch. A classic <script> is exempt from the CORS rules that make fetch()
  // fail on a file:// URL, so opening index.html straight off disk shows the
  // real shows and posts instead of nothing.
  await writeFile(
    DATA_FILE,
    '// Generated by scripts/fetch-data.mjs — do not edit by hand.\n' +
      `window.NSDS_DATA = ${JSON.stringify(next, null, 2)};\n`,
  );

  console.log(
    `\nwrote ${path.relative(ROOT, DATA_FILE)} — ` +
      `${next.stats.shows} shows, ${next.stats.attendees} attendees, ${next.stats.cities} cities`,
  );
}

// Surface partial failures without failing the build: a stale section still
// renders, and the workflow log keeps the reason.
if (failures.length) console.warn(`\ncompleted with warnings:\n  ${failures.join('\n  ')}`);
