// Frame times out of ffmpeg's `showinfo` filter (used by tools/carousel/draft.mjs).
//
// showinfo prints each frame's `pts` as an integer in the filter's input time base, plus a
// `pts_time` decimal. The decimal is printed with %.6g on ffmpeg 5.1 (the runner's Debian), which
// keeps only 4 digits after the point between 10 s and 100 s and 3 between 100 s and 1000 s, rounded
// to nearest, so it can land above the true time and an `-ss t` would then grab the NEXT frame. So
// the time is computed from the integer pts and the time base (`config in time_base: N/D`, printed
// once before the first frame) and floored to a millisecond. pts_time is never read.

const BASE_RE = /Parsed_showinfo\S*\s+@\s+\S+\]\s+config in time_base:\s*(\d+)\/(\d+)/
const FRAME_RE = /Parsed_showinfo\S*\s+@\s+\S+\]\s+n:\s*\d+\s+pts:\s*(-?\d+)\b/

/** fromMs: the seek origin in whole milliseconds. times(): each frame's t in seconds, in order. */
export function showinfoParser(fromMs) {
  let base = null
  const out = []
  return {
    line(text) {
      const b = text.match(BASE_RE)
      if (b) { base = { n: BigInt(b[1]), d: BigInt(b[2]) }; return }
      const f = text.match(FRAME_RE)
      if (!f) return
      if (!base || base.d === 0n) throw new Error('showinfo gave a frame before its time base')
      // floor(pts * N / D seconds, in ms); pts is non-negative for a seek that starts at `from`.
      const ms = (BigInt(f[1]) * base.n * 1000n) / base.d
      out.push((fromMs + Number(ms)) / 1000)
    },
    times: () => out,
  }
}

export const toMs = seconds => Math.round(Number(seconds.toFixed(3)) * 1000)
