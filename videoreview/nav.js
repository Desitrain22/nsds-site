// Navigation generations — the one rule that keeps a slow response from painting the wrong screen.
//
// Every screen here is reached by an async hop: pick a show, wait on Drive; pick a tape, wait on
// YouTube and the sheet. Nothing cancels those waits, so two clicks put two responses in flight and
// the LAST one to resolve wins the DOM. That is not a cosmetic race. `selectShow` writes the tape
// grid while `state.show` already points at the other show, so opening a tape from that grid sends
// the first show's fileId to the second show's sheet — a save lands on the wrong document.
//
// The fix is to make "is anyone still looking at this?" a thing you have to answer. Levels are
// ordered outermost-first; entering one bumps it AND everything nested inside it, because picking a
// new show abandons the tape you had open too. A token records the counters for its own level and
// its ancestors only — so opening a tape does not invalidate the tape-list fetch still running for
// the show it belongs to.

export class Nav {
  /** @param {string[]} levels outermost first, e.g. ['show', 'tape'] */
  constructor(levels) {
    this.levels = levels.slice()
    this.counters = new Map(this.levels.map(l => [l, 0]))
  }

  /** Begin a navigation at `level`, abandoning anything nested inside it. Returns its token. */
  enter(level) {
    const from = this._index(level)
    for (const l of this.levels.slice(from)) this.counters.set(l, this.counters.get(l) + 1)
    return this.token(level)
  }

  /** A token for work starting now at `level`, without navigating. */
  token(level) {
    const upto = this.levels.slice(0, this._index(level) + 1)
    return { level, at: upto.map(l => [l, this.counters.get(l)]) }
  }

  /** Is this token still the newest navigation at its level? */
  alive(token) {
    return !!token && token.at.every(([l, n]) => this.counters.get(l) === n)
  }

  /**
   * Await `promise` under `token`.
   *
   * Resolves `{state:'ok', value}` / `{state:'error', error}` only while the token is current, and
   * `{state:'stale'}` otherwise — including when abandoned work REJECTED, since a failure on a
   * screen nobody is looking at is not a failure worth showing. Callers switch on `state` instead
   * of try/catch, which makes forgetting the staleness check a syntax you'd have to write on
   * purpose rather than one you fall into by default.
   */
  async settle(token, promise) {
    try {
      const value = await promise
      return this.alive(token) ? { state: 'ok', value } : { state: 'stale' }
    } catch (error) {
      return this.alive(token) ? { state: 'error', error } : { state: 'stale' }
    }
  }

  _index(level) {
    const i = this.levels.indexOf(level)
    if (i < 0) throw new Error(`unknown nav level: ${level}`)
    return i
  }
}
