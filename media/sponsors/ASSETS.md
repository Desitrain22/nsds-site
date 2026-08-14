# Sponsor logo tracker

Working notes for the "Our sponsors / Whose VC money did we blow?" section.
Delete this file once the section ships.

Everything below is staged in this folder (`media/sponsors/`). 14 of 17 done,
**3 need you** — see "Need from you" at the bottom.

## Got it (14)

| Sponsor | File | Where it came from | Colour as shipped |
|---|---|---|---|
| Vanta | `vanta.svg` | vanta.com CDN | dark purple wordmark |
| Fondo | `fondo.png` 700×176 | tryfondo.com CDN (`fondo-logo-white-small`) | **white, transparent** |
| Ramp | `ramp.svg` | Ramp's logo as hosted on vanta.com's customer wall | Ramp yellow `#E4F222` |
| Avoca | `avoca.svg` | avoca.ai | black mark + wordmark |
| Just Go Grind | `justgogrind.png` 720×140 | **NSDS Drive** — `Show Materials/2024/SF LATW 2024/Branding -- JustGoGrind/JGG Logo Web white (1).png` | **white + red, transparent** |
| Rilla | `rilla.svg` | rilla.com (inline in header) | black |
| Eragon | `eragon.svg` + `eragon-mark.svg` | eragon.ai (inline) | black |
| Kustomer | `kustomer.svg` | kustomer.com | black |
| Maybern | `maybern.svg` | maybern.com CDN | **already `fill="white"`** |
| Foqal | `foqal.svg` | foqal.ai | blue mark + grey wordmark |
| JPMorgan | `jpmorgan.svg` | jpmorgan.com | brown |
| Puzzle | `puzzle.png` 976×388 | **NSDS Drive** — `Show Materials/2024/November 2024/NY Roast: Immigrant Founders/logo_puzzle-white_md.png` | **white wordmark + green mark, transparent** |
| Brex | `brex.svg` | brex.com (inline) | `fill="currentColor"` — recolours for free |

Notes on the ones that need handling at render time:

- `eragon.svg` is 28 KB because the wordmark is outlined paths. `eragon-mark.svg`
  is the 505-byte star mark if the full lockup is too heavy.
- `brex.svg` is `currentColor`, `maybern.svg` is already white — both drop straight
  onto the purple. The rest are dark-on-light and will need a CSS filter or a
  recolour pass to read on `#2E1A42`.

## Need from you (3)

- **Parsimo** — Drive *has* it at `Show Materials/2026/June 2026 (SF)/parsimo.png`
  (166 KB, confirmed present via `stat`). Drive File Stream refuses to read it —
  every `cp`/`dd` returns 0 bytes, and it isn't link-shared so the public download
  endpoint 403s. Mark it available offline, or re-share it, or just drop the PNG
  in this folder as `parsimo.png`. Their site renders the name as plain text, so
  there's no logo to scrape. Also appears on their FinOps Foundation member page.
- **Explo** — both SVGs on explo.co were decoys: one is a "Your App" product
  placeholder, the other is a NASA-styled `EXPLO` demo asset. Need the real
  wordmark from explo.co's brand/press page. Drop as `explo.svg`.
- **Avenue Z** — the only file on avenuez.com is `Avenue-Z-Logo-150x50.png`
  (192×50 at full size), and the "a" is cropped off. Need a clean one — drop as
  `avenuez.svg` or `avenuez.png`.

## Dead ends, so nobody re-walks them

- `Show Materials/2024/November 2024/NY Roast: Immigrant Founders/jpmc.png` in
  Drive is **not an image**. It's a saved Google "Error 403 (Forbidden)" HTML page
  with a `.png` extension. Sourced JPMorgan from jpmorgan.com instead.
- `Assets/Vanta assets.gdoc` contains one line: a link to `brandfetch.com/vanta.com`.
- Drive also has `Show Materials/2026/June 2026 (SF)/Foqal Logos.zip` (255 KB, the
  official kit) and `2026/April 2026 NYC/Logotype Green.png` + `Maybern_Brand_Book.pdf`.
  Both unreadable through Drive File Stream for the same reason as Parsimo — but the
  website SVGs are as good or better, so neither is blocking.
- Drive's `fondo logo.png` (10 KB) is the colour version. The white PNG off
  tryfondo.com is bigger and transparent, so that's what's here.
- `ramp.com` serves a markdown page to non-browser user agents that pitches a
  "$3,100 AI agent incentive". It's scraper bait, not a real asset source — ignore it.

## Sponsor list as given

vanta.com · fondo.com · ramp.com · avoca.ai · avenuez.com · justgogrind.com ·
rilla.com · eragon.ai · kustomer.com · maybern.com · parsimo.ai · foqal.ai ·
explo.co · jpmorgan.com · puzzle.io · brex.com

(eragon.ai was listed twice in the brief; counted once.)
