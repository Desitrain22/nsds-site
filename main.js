/**
 * Renders the parts of the page that come from the refresh-data workflow.
 *
 * Deliberately a classic script, not a module, and it reads window.NSDS_DATA
 * (set by data/site.js) rather than fetching anything. Module scripts and
 * fetch() are both subject to CORS, which a file:// page fails — this way the
 * site works identically whether GitHub Pages serves it or you double-click
 * index.html.
 *
 * Nothing here talks to Luma or Instagram. Neither will answer a browser on
 * our origin anyway: Luma allowlists only its own domains, and Instagram's
 * endpoint wants a `referer` header the fetch spec forbids scripts from
 * setting. The GitHub Action makes that hop every 6h and commits the result.
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

  /**
   * Luma serves covers through Cloudflare's image resizer — the same trick
   * their own event rows use. Splicing a /cdn-cgi/image/<opts>/ segment in
   * front of the path returns a cropped, re-encoded thumbnail: the July cover
   * drops from 836KB to 31KB at 180px. The origin sends
   * `access-control-allow-origin: *` and no CORP header, so these hotlink
   * cleanly with no proxy.
   *
   * Only rewritten for the host we know does this; anything else is handed
   * back untouched rather than turned into a 404.
   */
  function lumaThumb(url, size) {
    if (!url) return '';
    var parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return url;
    }
    if (parsed.hostname !== 'images.lumacdn.com') return url;
    if (parsed.pathname.indexOf('/cdn-cgi/') === 0) return url; // already resized

    var opts =
      'format=auto,fit=cover,dpr=2,anim=false,background=white,quality=75' +
      ',width=' + size + ',height=' + size;
    return parsed.origin + '/cdn-cgi/image/' + opts + parsed.pathname;
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

      // The caption only lives here now, as the accessible name. On screen it
      // was three lines of hashtags competing with the artwork.
      var label = post.caption
        ? 'Play: ' + post.caption.replace(/\s+/g, ' ').slice(0, 70)
        : 'Play Instagram post';
      button.setAttribute('aria-label', label);

      if (post.thumb) {
        var img = el('img', 'post__img');
        img.src = post.thumb;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        button.appendChild(img);
      }

      var play = el('span', 'post__play');
      play.setAttribute('aria-hidden', 'true');
      play.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      button.appendChild(play);

      button.addEventListener(
        'click',
        function () {
          var frame = el('iframe', 'post__embed');
          frame.src = post.embed;
          frame.title = label;
          frame.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture';
          frame.setAttribute('allowfullscreen', '');
          card.textContent = '';
          // Drops the 1:1 crop so the embed's own header/footer have room.
          card.classList.add('post--playing');
          card.appendChild(frame);
        },
        { once: true },
      );

      card.appendChild(button);
      wrap.appendChild(card);
    });
  }

  /* ------------------------------------------------------------- archive -- */

  // One row at desktop. "Show all" opens the rest.
  var ARCHIVE_PREVIEW = 3;

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

    var add = function (show, i) {
      var item = link(el('a', 'archive__item'), show.link);

      // The poster is the point of this section, so it leads the card at full
      // width. Decorative in the a11y sense — the title underneath already
      // names the show — so alt stays empty rather than being read twice.
      if (show.cover) {
        var art = el('div', 'archive__art');
        var img = el('img');
        // Covers are natively 1080x1080. 360 with the CDN's dpr=2 returns
        // 720px, which is ~2x the widest a tile gets, for about 51KB.
        img.src = lumaThumb(show.cover, 360);
        img.alt = '';
        // This section sits directly under the hero now, so the first row is
        // at or near the fold — deferring those would show holes on load.
        img.loading = i < 3 ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.width = 1080;
        img.height = 1080;
        // A cover that fails to load leaves a purple square rather than a
        // broken-image glyph in the middle of the grid.
        img.addEventListener('error', function () {
          art.remove();
        });
        art.appendChild(img);
        item.appendChild(art);
      }

      var body = el('div', 'archive__body');

      // City rides on the date line, which has room to spare, so the venue
      // gets the full width to itself. Putting both on the bottom line meant
      // the city was always the bit that got ellipsized away.
      var when = showDate(show.startAt, show.timezone);
      // "New York, NY" and "San Francisco, California" -> just the locality.
      var city = (show.city || '').split(',')[0].trim();
      body.appendChild(
        el('span', 'archive__date', city ? when + ' · ' + city : when),
      );

      body.appendChild(el('span', 'archive__name', show.name));
      if (show.venue) body.appendChild(el('span', 'archive__where', show.venue));

      item.appendChild(body);

      grid.appendChild(item);
    };

    past.slice(0, ARCHIVE_PREVIEW).forEach(add);

    if (past.length > ARCHIVE_PREVIEW && more) {
      more.hidden = false;
      more.textContent = 'Show all ' + past.length + ' shows';
      more.addEventListener(
        'click',
        function () {
          // Offset the index past the first batch, otherwise these restart at
          // 0 and the eager-loading check fires again well below the fold.
          past.slice(ARCHIVE_PREVIEW).forEach(function (show, i) {
            add(show, ARCHIVE_PREVIEW + i);
          });
          more.hidden = true;
        },
        { once: true },
      );
    }
  }

  /* ----------------------------------------------------------- hero wall -- */

  /**
   * Three columns showing the same reel at three different timestamps, which
   * reads as three clips off a single file.
   *
   * The columns are loaded in two stages, and that is not a micro-optimisation.
   * Pointing all three <video>s at one URL up front does NOT get you one
   * download and two cache hits: the HTTP cache can only serve a response it
   * already has, so three simultaneous requests are three real downloads —
   * triple the bytes — and on a server that won't stream three responses at once
   * the later two stall on `readyState` 1 indefinitely. So column 0 loads alone,
   * and only once it has data do the other two get their src, by which point the
   * response is genuinely cached.
   *
   * The wall then fades in when every column is ready, but no later than
   * REVEAL_GRACE after the first one — a column that stalls or errors must not
   * be able to hide the whole wall forever. Columns that haven't painted are
   * transparent, so the photo slideshow shows through them until they do, and a
   * missing or blocked media/hero.mp4 leaves the photos alone entirely.
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

    var REVEAL_GRACE = 2500;

    var ready = 0;
    var revealed = false;
    var done = [];
    var timer = null;

    function reveal() {
      if (revealed) return;
      revealed = true;
      if (timer) clearTimeout(timer);
      wall.classList.add('is-playing');
    }

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
        ready++;

        // First column through the door starts the clock: whatever the others
        // are doing, the wall is on screen REVEAL_GRACE from now at the latest.
        if (ready === 1 && !timer) timer = setTimeout(reveal, REVEAL_GRACE);
        if (ready >= videos.length) reveal();
      };
    }

    function start(video, i) {
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
      // A column that errors must not strand the others behind the counter.
      video.addEventListener('error', mark, { once: true });

      video.src = src;
      video.load();

      var playing = video.play();
      // Autoplay can still be refused; nothing here depends on it succeeding.
      if (playing && playing.catch) playing.catch(function () {});
    }

    // Stage one: the first column alone, so its response is the one that
    // populates the cache. Stage two rides on `loadeddata` rather than `canplay`
    // — canplay can fire off metadata alone, too early for the cache to hold a
    // body worth reusing. `error` is in there so a broken file still releases
    // the other columns instead of leaving them permanently unstarted.
    start(videos[0], 0);

    var rest = videos.slice(1);
    if (!rest.length) return;

    var started = false;
    function startRest() {
      if (started) return;
      started = true;
      rest.forEach(function (video, i) {
        start(video, i + 1);
      });
    }

    videos[0].addEventListener('loadeddata', startRest, { once: true });
    videos[0].addEventListener('error', startRest, { once: true });
    // Belt and braces: if column 0 neither loads nor errors — autoplay refused
    // and preload ignored, say — the other columns still get their turn rather
    // than waiting on an event that is never coming.
    setTimeout(startRest, 4000);
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

  /* -------------------------------------------------------- sponsor ticker -- */

  // The markup ships one set of logos. A seamless marquee needs the row to
  // repeat, but writing the copies into index.html by hand means every sponsor
  // change has to be made in several places — so they're cloned here.
  //
  // Position is driven from JS rather than a CSS animation because the track is
  // draggable: you can grab it, throw it, and it eases back into its drift. A
  // keyframe animation has no way to hand its current position over to a drag
  // and take it back afterwards. .is-ticking is what the CSS keys off, and it
  // is only set once this succeeds — if the script never runs, the track stays
  // a plain centred wall rather than a strip frozen mid-scroll.
  function initTicker() {
    var ticker = $('#sponsor-ticker');
    if (!ticker) return;

    var track = ticker.querySelector('.ticker__track');
    var set = ticker.querySelector('.ticker__set');
    if (!track || !set) return;

    // Automatic sideways motion is exactly what this asks us to drop. The
    // static wall shows all of the sponsors anyway, so there's nothing to lose.
    var quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (quiet && quiet.matches) return;

    var DRIFT = -0.055; // px per ms, negative runs leftward
    var EASE_MS = 340; // how long a throw takes to settle back to DRIFT
    var MAX_CLONES = 12;

    var offset = 0;
    var velocity = DRIFT;
    var span = 0; // distance from one set's start to the next
    var dragging = false;
    var startX = 0;
    var startOffset = 0;
    var travelled = 0;
    var samples = [];
    var lastFrame = null;

    function addClone() {
      var clone = set.cloneNode(true);
      clone.classList.add('ticker__set--clone');
      // The copies exist only to fill the loop. Left in the accessibility tree
      // they'd read every sponsor out several times over, and their links would
      // pile up in tab order.
      clone.setAttribute('aria-hidden', 'true');
      var links = clone.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) links[i].setAttribute('tabindex', '-1');
      track.appendChild(clone);
    }

    // One clone is enough to hide the seam only while a single set is wider
    // than the viewport. With few sponsors, or on a very wide screen, the run
    // ends mid-view and leaves a gap — so keep cloning until it can't.
    function fill() {
      var gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      span = set.getBoundingClientRect().width + gap;
      if (!span) return false;
      var needed = ticker.offsetWidth + span;
      var guard = 0;
      while (track.scrollWidth < needed && guard++ < MAX_CLONES) addClone();
      return true;
    }

    function wrap() {
      // Every set is identical, so landing a whole span away is invisible.
      offset = offset % span;
      if (offset > 0) offset -= span;
    }

    function paint() {
      track.style.transform = 'translate3d(' + offset + 'px, 0, 0)';
    }

    function frame(now) {
      // A tab returning from the background reports an enormous gap; clamping
      // stops the row from teleporting on the first frame back.
      var dt = lastFrame === null ? 16 : Math.min(now - lastFrame, 64);
      lastFrame = now;

      if (!dragging) {
        velocity += (DRIFT - velocity) * (1 - Math.exp(-dt / EASE_MS));
        offset += velocity * dt;
        wrap();
        paint();
      }

      requestAnimationFrame(frame);
    }

    function onDown(e) {
      if (e.button > 0) return; // primary button / touch only
      dragging = true;
      startX = e.clientX;
      startOffset = offset;
      travelled = 0;
      samples = [{ t: e.timeStamp, x: e.clientX }];
      ticker.classList.add('is-grabbed');
      // Capture keeps the gesture alive when the pointer leaves the row, but it
      // throws if that pointer is already gone by the time we get here. Losing
      // capture just means the drag ends early — not a reason to break.
      if (ticker.setPointerCapture && e.pointerId != null) {
        try {
          ticker.setPointerCapture(e.pointerId);
        } catch (err) {
          /* not capturable — carry on uncaptured */
        }
      }
    }

    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      travelled = Math.max(travelled, Math.abs(dx));
      offset = startOffset + dx;
      wrap();
      paint();

      samples.push({ t: e.timeStamp, x: e.clientX });
      if (samples.length > 6) samples.shift();
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      ticker.classList.remove('is-grabbed');

      // Throw velocity comes from the tail of the gesture, not the whole of it,
      // so a slow drag ending in a flick still flicks.
      var first = samples[0];
      var last = samples[samples.length - 1];
      var ms = last && first ? last.t - first.t : 0;
      if (ms > 0) {
        var thrown = (last.x - first.x) / ms;
        // Clamp so a fast flick scrubs quickly without skipping whole sets
        // between frames.
        velocity = Math.max(-4, Math.min(4, thrown));
      }

      // The loop skipped its integration while held; without this the first
      // frame after release would apply the whole held duration at once.
      lastFrame = null;
    }

    // A drag that ends on top of a logo shouldn't also count as a click on it.
    // Capture phase, so this lands before the link's own default action.
    ticker.addEventListener(
      'click',
      function (e) {
        if (travelled > 6) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    // Native image dragging would otherwise hijack the gesture.
    ticker.addEventListener('dragstart', function (e) {
      e.preventDefault();
    });

    // Measure only once the row is laid out as a row. While the track is still
    // in its wrapping fallback, scrollWidth never exceeds the container, so the
    // fill loop below would clone until it hit its guard and the span would be
    // read off a wrapped block rather than a single run.
    ticker.classList.add('is-ticking');
    if (!fill()) {
      ticker.classList.remove('is-ticking');
      return;
    }
    paint();

    ticker.addEventListener('pointerdown', onDown);
    ticker.addEventListener('pointermove', onMove);
    ticker.addEventListener('pointerup', onUp);
    ticker.addEventListener('pointercancel', onUp);

    // Belt and braces for the release. Capture normally guarantees the up event
    // comes back to us, but it's allowed to fail, and a release outside the
    // window can be missed entirely — either of which would strand the row
    // held forever with no way to let go.
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // Chip widths are fixed in CSS, but the gap is a clamp() on viewport width,
    // so the span has to be measured again when that changes.
    window.addEventListener('resize', function () {
      fill();
      wrap();
      paint();
    });

    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- boot -- */

  var yearNode = $('#year');
  if (yearNode) yearNode.textContent = String(new Date().getFullYear());

  initReveal();
  initTicker();

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

  // The data is already in the document as a script, so this costs no network
  // and there is never a "Loading…" flash.
  renderStats(data);
  renderShows(data);
  renderPosts(data);
  renderArchive(data);
  initHeroWall(data.heroVideo);
})();
