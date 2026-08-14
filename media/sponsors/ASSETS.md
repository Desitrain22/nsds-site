# Sponsor logos

Source notes for the sponsor ticker in `index.html` (`#sponsors`).
**All 16 sponsors have a logo — nothing outstanding.**

## The one rule for anything added here

The ticker sits each logo on a near-white chip (`#fbfaf7`) and keeps its own
colours — there's no monochrome filter. **So every file has to be the
dark-on-light version.** A white/knockout logo is invisible on the chip. Four of
the files below started life white and had to be inverted; if you replace one,
take the light-background variant from the brand kit.

## Where each one came from

| Sponsor | File | Source |
|---|---|---|
| Vanta | `vanta.svg` | vanta.com CDN |
| Fondo | `fondo.png` 321×81 | tryfondo.com CDN — colour version, *not* the white one |
| Ramp | `ramp.svg` | Ramp's logo as hosted on vanta.com's customer wall |
| Avoca | `avoca.svg` | avoca.ai |
| Avenue Z | `avenuez.png` 281×73 | supplied by Neal |
| Just Go Grind | `justgogrind.png` 720×140 | **NSDS Drive** — `Show Materials/2024/SF LATW 2024/Branding -- JustGoGrind/JGG Logo Web white (1).png` |
| Rilla | `rilla.svg` | rilla.com (inline in header) |
| Eragon | `eragon.svg` + `eragon-mark.svg` | eragon.ai (inline) |
| Kustomer | `kustomer.svg` | kustomer.com |
| Maybern | `maybern.svg` | maybern.com CDN |
| Parsimo | `parsimo.png` 900×124 | supplied by Neal |
| Foqal | `foqal.svg` | foqal.ai |
| Explo | `explo.png` 900×253 | **NSDS Drive** — `Show Materials/2024/November 2024/NY Roast: Immigrant Founders/Logo (5)(1).png` |
| JPMorgan | `jpmorgan.svg` | jpmorgan.com |
| Puzzle | `puzzle.png` 976×388 | **NSDS Drive** — `.../NY Roast: Immigrant Founders/logo_puzzle-dark_md.png` |
| Brex | `brex.svg` | brex.com (inline) |

## Files that aren't byte-identical to their source

- **`justgogrind.png`** — ships as white type + a red mark. The white type was
  recoloured to ink pixel by pixel; anything with real saturation (the red "GO")
  was left alone, so the mark is untouched.
- **`maybern.svg`** — was `fill="white"` throughout (their site is dark). All 12
  fills recoloured to ink.
- **`ramp.svg`** — logo paths were Ramp yellow `#E4F222`, near-invisible on the
  chip, so they were recoloured to ink. The `fill="white"` on the luminance mask
  is load-bearing and was left alone.
- **`brex.svg`** — lifted from inline HTML, where `xmlns` is implied. A
  standalone `.svg` in an `<img>` needs it declared or the image silently fails
  to load. Added. Fills are `currentColor`.
- **`parsimo.png`, `avenuez.png`, `explo.png`** — white matte flattened to
  transparency, dead margin trimmed, downscaled. Parsimo arrived at 4000×1012
  with most of that height as padding; trimmed it's a 7.3:1 wordmark.
- **`eragon.svg`** is 28 KB because the wordmark is outlined paths.
  `eragon-mark.svg` is the 505-byte star if the full lockup ever needs to go.

## Dead ends, so nobody re-walks them

- `.../NY Roast: Immigrant Founders/jpmc.png` in Drive is **not an image**. It's
  a saved Google "Error 403 (Forbidden)" HTML page with a `.png` extension.
  JPMorgan came from jpmorgan.com instead.
- `Assets/Vanta assets.gdoc` contains one line: a link to `brandfetch.com/vanta.com`.
- Explo's own site is a trap: `explo.co` serves a "Your App" product placeholder
  and a NASA-styled `EXPLO` asset that reads as a demo. The second one is
  actually close — Explo's palette really is NASA blue and red — but the Drive
  file is the true logo.
- Drive also holds `Show Materials/2026/June 2026 (SF)/Foqal Logos.zip` (255 KB,
  the official kit) and `2026/April 2026 NYC/Logotype Green.png` +
  `Maybern_Brand_Book.pdf`. All unreadable through Drive File Stream — reads
  return 0 bytes while `stat` reports the true size — but the website files are
  as good, so none were blocking.
- `ramp.com` serves a markdown page to non-browser user agents pitching a
  "$3,100 AI agent incentive". Scraper bait, not an asset source.

## Adding a sponsor before their logo arrives

`.sponsor__link--text` in `style.css` sets the name in the brand face at the
weight of the marks around it. Same `<a>`, minus the `<img>`:

```html
<li class="sponsor">
  <a class="sponsor__link sponsor__link--text" href="https://example.com"
     target="_blank" rel="noopener">Example</a>
</li>
```

Nothing uses it right now. Add `sponsor__img--lockup` to any logo whose symbol
eats most of its height, or it renders shrunken beside the pure wordmarks.
