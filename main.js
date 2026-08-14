/**
 * Renders the parts of the page that come from the refresh-data workflow.
 *
 * Deliberately a classic script, not a module, and it reads window.NSDS_DATA
 * (set by data/site.js) instead of fetching data/site.json. Both module
 * scripts and fetch() are subject to CORS, which a file:// page fails — so
 * this way the site works identically whether GitHub Pages serves it or it's
 * opened straight off disk by double-clicking index.html.
 *
 * Nothing here talks to Luma or Instagram directly. Their APIs don't send CORS
 * headers and would rate-limit us per visitor; the GitHub Action makes that
 * hop once and commits the result.
 */
(function () {
  'use strict';

  /**
   * The Cloudflare Worker in worker/ that fronts Luma and Instagram. Set this
   * to the deployed URL (no trailing slash) to turn on live data; leave it
   * null and the site runs entirely on the committed copy, issuing no request.
   *
   * It exists because neither API will talk to a browser on our origin: Luma
   * allowlists only its own domains, and Instagram's endpoint requires a
   * `referer` header the fetch spec forbids page scripts from setting.
   */
  var API = null; // e.g. 'https://nsds-api.yourname.workers.dev'

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  /* ----------------------------------------------------------- utilities -- */

  /**
   * Build an element with text set safely. Event names and Instagram captions
   * are other people's strings — they go through textContent, never innerHTML.
   */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function link(node, href) {
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener';
    return node;
  }

  /** "Jul 30, 2026" in the timezone the show actually happened in. */
  function showDate(iso, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: timeZone || 'America/New_York',
      }).format(new Date(iso));
    } catch (err) {
      return new Date(iso).toLocaleDateString('en-US');
    }
  }

  function compactNumber(n) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  }

  /* --------------------------------------------------------------- stats -- */

  /**
   * Fills every [data-stat] on the page. The landing page hero and the metric
   * cards on sponsorship.html both use these, so this walks the whole document
   * rather than one container.
   */
  function renderStats(data) {
    if (!data.stats) return;

    var values = {
      shows: data.stats.shows,
      attendees: data.stats.attendees,
      cities: data.stats.cities,
      followers: data.followers,
    };

    var shown = 0;
    var nodes = document.querySelectorAll('[data-stat]');

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var value = values[node.dataset.stat];

      if (!value) {
        // In the hero the placeholder is an em dash, so drop the item rather
        // than print a confident "0". Elsewhere (the sponsorship metric cards)
        // the markup ships a real figure — leave that standing.
        var stat = node.closest('.stat');
        if (stat) stat.remove();
        continue;
      }

      node.textContent = value >= 1000 ? compactNumber(value) : String(value);
      shown++;
    }

    var wrap = $('#stats');
    if (wrap && shown) wrap.hidden = false;
  }

  /* --------------------------------------------------------------- shows -- */

  function renderShows(data) {
    var list = $('#shows-list');
    if (!list) return;
    list.textContent = '';

    var upcoming = data.upcoming || [];

    // No upcoming shows is a normal state — there are quiet weeks between runs.
    // Say so plainly and give people somewhere to go.
    if (!upcoming.length) {
      var box = el('div', 'no-shows');
      box.appendChild(el('p', 'no-shows__title', 'No dates on sale right now'));
      box.appendChild(
        el(
          'p',
          'no-shows__body',
          "We're between runs — the next one usually goes up a few weeks out. Follow along and you'll hear first (plus discount codes).",
        ),
      );

      var actions = el('div', 'cta__actions');
      actions.appendChild(
        link(el('a', 'pill pill--solid', 'Follow for the drop'), 'https://instagram.com/notsodailystandup'),
      );
      actions.appendChild(
        link(el('a', 'pill pill--ghost', 'Subscribe on Luma'), 'https://luma.com/user/TechComedyShow'),
      );
      box.appendChild(actions);
      list.appendChild(box);
      return;
    }

    upcoming.forEach(function (show) {
      var frame = el('iframe', 'show-embed');
      frame.src = show.embed;
      frame.title = show.name || 'Upcoming show';
      frame.loading = 'lazy';
      frame.allow = 'fullscreen; payment';
      list.appendChild(frame);
    });
  }

  /* ----------------------------------------------------------- instagram -- */

  /**
   * Renders a thumbnail with a play button. The Instagram iframe is only
   * inserted on click — that keeps their ~130KB embed (and its cookies) off
   * the page for the majority of visitors who never press play.
   */
  function renderPosts(data) {
    var wrap = $('#posts');
    if (!wrap) return;

    var posts = data.instagram || [];
    wrap.textContent = '';

    if (!posts.length) {
      var fallback = el('p', 'section__intro');
      fallback.appendChild(
        link(el('a', null, 'See the latest on Instagram →'), 'https://instagram.com/notsodailystandup'),
      );
      wrap.appendChild(fallback);
      return;
    }

    posts.forEach(function (post) {
      var card = el('article', 'post');

      var button = el('button', 'post__preview');
      button.type = 'button';
      var label = post.caption
        ? 'Play Instagram post: ' + post.caption.slice(0, 80)
        : 'Play Instagram post';
      button.setAttribute('aria-label', label);

      if (post.thumb) {
        var img = el('img', 'post__img');
        img.src = post.thumb;
        img.alt = '';
        img.loading = 'lazy';
        button.appendChild(img);
      }

      var play = el('span', 'post__play');
      play.setAttribute('aria-hidden', 'true');
      play.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

      var overlay = el('div', 'post__overlay');
      var meta = el('div', 'post__meta');
      meta.appendChild(el('span', null, post.isVideo ? 'Reel' : 'Post'));
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, showDate(post.takenAt)));
      overlay.appendChild(meta);
      if (post.caption) overlay.appendChild(el('p', 'post__caption', post.caption));

      button.appendChild(play);
      button.appendChild(overlay);

      button.addEventListener(
        'click',
        function () {
          var frame = el('iframe', 'post__embed');
          frame.src = post.embed;
          frame.title = label;
          frame.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture';
          frame.setAttribute('allowfullscreen', '');
          card.textContent = '';
          card.appendChild(frame);
        },
        { once: true },
      );

      card.appendChild(button);
      wrap.appendChild(card);
    });
  }

  /* ------------------------------------------------------------- archive -- */

  var ARCHIVE_PREVIEW = 9;

  function renderArchive(data) {
    var grid = $('#archive');
    var more = $('#archive-more');
    if (!grid) return;

    // This runs a second time when live data arrives, so start from empty —
    // appending onto the previous render would show every show twice. Swapping
    // the button for a clone drops the old {once:true} click handler with it.
    grid.textContent = '';
    if (more) {
      var fresh = more.cloneNode(true);
      fresh.hidden = true;
      more.parentNode.replaceChild(fresh, more);
      more = fresh;
    }

    // Most recent first reads better as a highlight reel than oldest first.
    var past = (data.past || []).slice().sort(function (a, b) {
      return new Date(b.startAt) - new Date(a.startAt);
    });

    // Hidden when there's nothing to show, but explicitly unhidden otherwise —
    // a first render with no data must not permanently bury the section from
    // the live one that follows.
    var section = grid.closest('.section');
    if (section) section.hidden = !past.length;
    if (!past.length) return;

    var add = function (show) {
      var item = link(el('a', 'archive__item'), show.link);
      item.appendChild(el('span', 'archive__date', showDate(show.startAt, show.timezone)));
      item.appendChild(el('span', 'archive__name', show.name));
      item.appendChild(
        el(
          'span',
          'archive__where',
          [show.venue, show.city].filter(Boolean).join(' · '),
        ),
      );
      grid.appendChild(item);
    };

    past.slice(0, ARCHIVE_PREVIEW).forEach(add);

    if (past.length > ARCHIVE_PREVIEW && more) {
      more.hidden = false;
      more.textContent = 'Show all ' + past.length + ' shows';
      more.addEventListener(
        'click',
        function () {
          past.slice(ARCHIVE_PREVIEW).forEach(add);
          more.hidden = true;
        },
        { once: true },
      );
    }
  }

  /* ----------------------------------------------------------- hero wall -- */

  /**
   * Three columns showing the same reel at three different timestamps, which
   * reads as three clips while only ever downloading one file — the other two
   * <video>s hit the browser cache for the same URL.
   *
   * The whole wall fades in together, and only once every column has actually
   * decoded a frame. Revealing them one at a time looks like a bug, and a
   * missing or blocked media/hero.mp4 leaves the photo slideshow untouched.
   */
  function initHeroWall(src) {
    var wall = $('#hero-wall');
    if (!wall || !src) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Don't burn a phone plan's data on a decorative loop.
    if (navigator.connection && navigator.connection.saveData) return;

    // Skip any column the stylesheet has hidden — phones drop to a single pane.
    // Filtering here rather than letting CSS hide them means the extra columns
    // never get a src, so a phone decodes one video instead of three. The
    // surviving count is also what the offsets below divide by, so a single
    // column correctly gets no offset at all.
    var videos = [].slice.call(wall.querySelectorAll('.hero__col'))
      .filter(function (col) {
        return window.getComputedStyle(col).display !== 'none';
      })
      .map(function (col) {
        return col.querySelector('.hero__video');
      });
    if (!videos.length) return;

    var ready = 0;
    var revealed = false;

    /**
     * Counts columns, not events — each column reports at most once. Several
     * events below can mark the same column ready (`seeked` and `canplay` both
     * fire for a column that seeks) and `{ once: true }` only dedupes per
     * event name, so a shared counter would tally one column two or three
     * times and reveal the wall while another column was still blank.
     */
    function columnReady(index) {
      return function () {
        if (done[index]) return;
        done[index] = true;
        if (++ready < videos.length || revealed) return;
        revealed = true;
        wall.classList.add('is-playing');
      };
    }

    var done = [];

    videos.forEach(function (video, i) {
      // Spread the columns evenly across the runtime. duration isn't known
      // until metadata lands, so the offset is applied there rather than now.
      // Looping keeps the spacing by itself: all three advance at the same rate,
      // so the phase difference between them never drifts.
      video.addEventListener(
        'loadedmetadata',
        function () {
          var d = video.duration;
          if (d && isFinite(d)) video.currentTime = (d / videos.length) * i;
        },
        { once: true },
      );

      var mark = columnReady(i);

      // `canplay` can fire before the seek has painted; `seeked` is the honest
      // signal that this column has the frame it's meant to be showing. Column
      // 0 seeks to 0, which may not fire `seeked` at all — hence both.
      video.addEventListener('seeked', mark, { once: true });
      video.addEventListener('canplay', mark, { once: true });
      // A column that errors must not strand the other two behind the counter.
      video.addEventListener('error', mark, { once: true });

      video.src = src;
      video.load();

      var playing = video.play();
      // Autoplay can still be refused; nothing below depends on it succeeding.
      if (playing && playing.catch) playing.catch(function () {});
    });
  }

  /* -------------------------------------------------------------- reveal -- */

  function initReveal() {
    var targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    if (!('IntersectionObserver' in window)) return; // styles never engage

    // Only now do the hiding styles switch on — see the .reveal-ready note in
    // style.css. If this script never ran, the content simply stayed visible.
    document.documentElement.classList.add('reveal-ready');

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -10% 0px' },
    );

    for (var i = 0; i < targets.length; i++) io.observe(targets[i]);
  }

  /* ---------------------------------------------------------------- boot -- */

  var yearNode = $('#year');
  if (yearNode) yearNode.textContent = String(new Date().getFullYear());

  initReveal();

  var data = window.NSDS_DATA;

  if (!data) {
    // data/site.js missing or failed to parse. Replace the loading text with
    // links to the real sources rather than stranding anyone on "Loading…".
    var shows = $('#shows-list');
    if (shows) {
      shows.textContent = '';
      var p1 = el('p', 'section__intro');
      p1.appendChild(
        link(el('a', null, 'See all upcoming shows on Luma →'), 'https://luma.com/user/TechComedyShow'),
      );
      shows.appendChild(p1);
    }

    var posts = $('#posts');
    if (posts) {
      posts.textContent = '';
      var p2 = el('p', 'section__intro');
      p2.appendChild(
        link(el('a', null, 'See the latest on Instagram →'), 'https://instagram.com/notsodailystandup'),
      );
      posts.appendChild(p2);
    }

    var archive = $('#archive');
    var archiveSection = archive && archive.closest('.section');
    if (archiveSection) archiveSection.hidden = true;
    return;
  }

  function renderAll(d) {
    renderStats(d);
    renderShows(d);
    renderPosts(d);
    renderArchive(d);
  }

  // Paint the committed copy first. It's already in the document as a script,
  // so this costs no network and there is never a "Loading…" flash.
  renderAll(data);
  initHeroWall(data.heroVideo);

  /* ------------------------------------------------------- live refresh -- */

  /**
   * Then, if the Worker is configured, re-ask the real APIs and repaint. This
   * is stale-while-revalidate: a visitor sees good data instantly and the
   * live version a moment later, and every failure mode — no Worker, offline,
   * upstream 429, file:// — simply leaves the committed render in place.
   */
  if (!API) return;

  var get = function (path) {
    return fetch(API + path, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };

  // Merged into a copy rather than mutated in place, so a half-failed refresh
  // can never leave the page showing a mix of live and committed shows.
  var live = {};
  for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) live[k] = data[k];

  Promise.allSettled([get('/shows'), get('/instagram?limit=3')]).then(function (res) {
    var changed = false;

    if (res[0].status === 'fulfilled' && Array.isArray(res[0].value.past)) {
      live.upcoming = res[0].value.upcoming;
      live.past = res[0].value.past;
      live.stats = {
        shows: live.past.length,
        attendees: live.past.reduce(function (s, e) {
          return s + (e.guests || 0);
        }, 0),
        // Luma stores whatever the organiser typed — "New York, NY" and
        // "New York, New York" are both in the feed — so compare on the
        // normalized locality or the same city gets counted twice.
        cities: (function () {
          var seen = {};
          live.past.forEach(function (e) {
            if (!e.city) return;
            seen[e.city.split(',')[0].trim().toLowerCase().replace(/[^a-z ]/g, '')] = 1;
          });
          return Object.keys(seen).length;
        })(),
      };
      changed = true;
    }

    if (res[1].status === 'fulfilled' && res[1].value.posts && res[1].value.posts.length) {
      live.instagram = res[1].value.posts;
      if (res[1].value.followers) live.followers = res[1].value.followers;
      changed = true;
    }

    if (changed) renderAll(live);
  });
})();
