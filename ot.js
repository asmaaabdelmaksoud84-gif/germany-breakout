/* Operational transformation for the shared group answers.
 *
 * An edit is one splice: { p: position, d: charsDeleted, i: insertedText }.
 * The server holds the canonical text and a version number. A client sends its
 * splice together with the version it was composed against; the server
 * transforms that splice over every edit committed since, so two students
 * typing in different parts of the same answer never erase one another.
 *
 * Loaded by both the server (CommonJS) and the browser (global OT).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clampOp(op, textLen) {
    var p = Math.max(0, Math.min(textLen, op.p | 0));
    var d = Math.max(0, Math.min(textLen - p, op.d | 0));
    var i = typeof op.i === 'string' ? op.i : '';
    return { p: p, d: d, i: i };
  }

  function apply(text, op) {
    var o = clampOp(op, text.length);
    return text.slice(0, o.p) + o.i + text.slice(o.p + o.d);
  }

  /** Map a single position across an already-applied edit `b`. */
  function xformPos(p, b) {
    var bEnd = b.p + b.d;
    if (p <= b.p) return p;
    if (p >= bEnd) return p + b.i.length - b.d;
    return b.p + b.i.length;      // position fell inside b's deleted range
  }

  /**
   * Transform `a` (composed before `b` was applied) so it can be applied after
   * `b`. Deletions shrink where they overlap b's deletion; nothing is dropped.
   */
  function transform(a, b) {
    var start = xformPos(a.p, b);
    var end = xformPos(a.p + a.d, b);
    if (end < start) end = start;
    return { p: start, d: end - start, i: a.i };
  }

  /** Transform `a` over a list of already-applied edits, oldest first. */
  function transformOver(a, list) {
    var out = { p: a.p | 0, d: a.d | 0, i: typeof a.i === 'string' ? a.i : '' };
    for (var k = 0; k < list.length; k++) out = transform(out, list[k]);
    return out;
  }

  /**
   * Derive the minimal single splice turning `before` into `after`, using the
   * common prefix and suffix. This is what normal typing and pasting produce.
   */
  function diff(before, after) {
    if (before === after) return null;
    var n = Math.min(before.length, after.length), s = 0;
    while (s < n && before.charCodeAt(s) === after.charCodeAt(s)) s++;
    var e = 0;
    while (e < n - s &&
           before.charCodeAt(before.length - 1 - e) ===
           after.charCodeAt(after.length - 1 - e)) e++;
    return {
      p: s,
      d: before.length - s - e,
      i: after.slice(s, after.length - e)
    };
  }

  /** Keep a caret sensible after a remote edit lands. */
  function xformCaret(caret, op) { return xformPos(caret, clampOp(op, Infinity)); }

  return {
    apply: apply, transform: transform, transformOver: transformOver,
    diff: diff, xformPos: xformPos, xformCaret: xformCaret, clampOp: clampOp
  };
}));
