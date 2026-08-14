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

    // Most recent first reads better as a highlight reel than oldest first.
    var past = (data.past || []).slice().sort(function (a, b) {
      return new Date(b.startAt) - new Date(a.startAt);
    });

    if (!past.length) {
      var section = grid.closest('.section');
      if (section) section.hidden = true;
      return;
    }

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

  /* ---------------------------------------------------------- hero video -- */

  /**
   * The hero loop is optional and only referenced when fetch-data.mjs actually
   * found media/hero.mp4 on disk, so a site without one issues no request.
   */
  function initHeroVideo(src) {
    var video = $('#hero-video');
    if (!video || !src) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Don't burn a phone plan's data on a decorative loop.
    if (navigator.connection && navigator.connection.saveData) return;

    // Only reveal the video once it can actually paint; until then — and
    // forever, if the file fails — the photo slideshow underneath is what shows.
    video.addEventListener(
      'canplay',
      function () {
        video.classList.add('is-playing');
      },
      { once: true },
    );

    // Set the poster here rather than in the markup: as an attribute it costs
    // every visitor a full-size image download for a video that usually isn't
    // there, and the photo slideshow is already covering that ground.
    video.poster = 'media/opt/crowdpic-1600.jpg';
    video.src = src;
    video.load();

    var playing = video.play();
    // Autoplay can still be refused; nothing below depends on it succeeding.
    if (playing && playing.catch) playing.catch(function () {});
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

  renderStats(data);
  renderShows(data);
  renderPosts(data);
  renderArchive(data);
  initHeroVideo(data.heroVideo);
})();
