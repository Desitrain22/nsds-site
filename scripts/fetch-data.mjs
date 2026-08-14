#!/usr/bin/env node
/**
 * Refreshes the data the pages render from:
 *
 *   data/site.js - upcoming + past Luma shows and the tallies drawn from them.
 *                  Written as `window.NSDS_DATA = {...}` rather than JSON so a
 *                  <script> tag can load it — see main.js.
 *
 * Run by .github/workflows/refresh-data.yml on a cron, and by hand with
 * `npm run fetch`. No dependencies — plain Node 20+ for global fetch.
 *
 * The one rule this script cares about: never make the site worse. Every network
 * hop is allowed to fail, and a failed hop keeps whatever data/site.js already
 * had rather than overwriting it with nothing. A bad day at Luma should cost us
 * freshness, not the whole section.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'site.js');

const LUMA_USER = 'usr-5IoinAmtej3Z8xe'; // luma.com/user/TechComedyShow

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

// Instagram used to be fetched here. The clips on the page are now five
// hand-picked reels served from media/reels/ and listed in main.js — see the
// REELS comment there for why they're self-hosted rather than embedded.
// Dropping the fetch also removed the IG_TOKEN secret and the Graph API
// fallback that only existed because Instagram 429s GitHub's runners.
delete next.instagram;
delete next.followers;

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
