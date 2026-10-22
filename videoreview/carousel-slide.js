// The carousel slide markup: three stacked 1080x450 panels (a still with its caption) and the show's
// watermark. The editor shows this scaled down and headless Chromium renders it at 1080x1350 for the
// export, so what you preview is what gets posted.

import { SLIDE, PANEL, PANEL_ASPECT, CAROUSEL_DEFAULT_STYLE, CAROUSEL_LIMITS } from './carousel.js'
import { BUG, HEX_RE } from './reel.js'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c])
const num = n => (Number.isFinite(+n) ? +n : 0)
const cssUrl = u => String(u ?? '').replace(/[\\"\n\r\f<]/g, c => `\\${c.charCodeAt(0).toString(16)} `)
const colour = (c, fallback) => (HEX_RE.test(c) ? (c[0] === '#' ? c : `#${c}`) : fallback)

export const SLIDE_CSS = `
.cz-slide { position: relative; width: ${SLIDE.w}px; height: ${SLIDE.h}px; overflow: hidden; background: #000; }
.cz-panel { position: relative; width: ${PANEL.w}px; height: ${PANEL.h}px; overflow: hidden; }
.cz-panel img { position: absolute; display: block; max-width: none; }
.cz-panel img.cz-flat { left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; }
.cz-cap { position: absolute; transform: translate(-50%, -100%); width: max-content; max-width: 90%; text-align: center; line-height: 1.32; text-wrap: balance; }
.cz-cap span {
  padding: .1em .6em; border-radius: 999px; box-decoration-break: clone; -webkit-box-decoration-break: clone;
  font-family: 'cz-cap', sans-serif; font-weight: 800;
}
.cz-bug {
  position: absolute; top: 36px; right: 36px; display: flex; align-items: center; gap: ${BUG.gap}px;
  opacity: ${BUG.opacity}; color: #fff; text-align: right; text-shadow: 0 1px 6px rgb(0 0 0 / 60%);
  font-family: 'cz-bug', monospace; font-weight: 700; font-size: ${BUG.font}px; line-height: ${BUG.line}px;
}
.cz-bug img { width: ${BUG.icon}px; height: auto; display: block; }
`

// An <img> that shows a whole source frame so that `crop` fills the panel: percentages of the panel.
export function imgBox(crop, aspect) {
  const cw = crop.h * PANEL_ASPECT / aspect
  return { width: 100 / cw, left: -(crop.cx - cw / 2) / cw * 100, top: -(crop.cy - crop.h / 2) / crop.h * 100 }
}

function panelHtml(p, img, i) {
  const pic = img?.crop
    ? (b => `<img src="${esc(img.src)}" alt="" style="width:${b.width}%;left:${b.left}%;top:${b.top}%">`)(imgBox(img.crop, img.aspect))
    : `<img class="cz-flat" src="${esc(img?.src)}" alt="">`
  const cap = p.text
    ? `<div class="cz-cap" style="left:${num(p.cap?.x)}%;top:${num(p.cap?.y)}%"><span>${esc(p.text)}</span></div>`
    : ''
  return `<div class="cz-panel" data-i="${i}">${pic}${cap}</div>`
}

export function slideHtml(panels, style, { images = [], fonts = {} } = {}) {
  const box = colour(style?.box, CAROUSEL_DEFAULT_STYLE.box)
  const fg = colour(style?.fg, CAROUSEL_DEFAULT_STYLE.fg)
  const [lo, hi] = CAROUSEL_LIMITS.size
  const size = Math.min(hi, Math.max(lo, num(style?.size) || CAROUSEL_DEFAULT_STYLE.size))
  const css = `${SLIDE_CSS}
@font-face { font-family: 'cz-cap'; src: url("${cssUrl(fonts.caption)}"); font-weight: 100 900; }
@font-face { font-family: 'cz-bug'; src: url("${cssUrl(fonts.bug)}"); font-weight: 700; }
.cz-cap { font-size: ${size}px; }
.cz-cap span { background: ${box}; color: ${fg}; }`
  return `<style>${css}</style><div class="cz-slide">${panels.map((p, i) => panelHtml(p, images[i], i)).join('')}`
    + `<div class="cz-bug"><div>A.U<br>Tech Comedy Show</div><img src="${esc(fonts.icon)}" alt=""></div></div>`
}
