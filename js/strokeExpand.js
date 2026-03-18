/**
 * strokeExpand.js — Curve-preserving stroke expansion for OTF font export.
 *
 * Uses the Tiller-Hanson approach: offset cubic bezier curves directly
 * (rather than flattening to polylines), producing outlines with minimal
 * control points suitable for editing in font editors like Fontra.
 *
 * Pipeline per shape:
 *   shape points (0–1) → font-unit mapping → centerline segments →
 *   adaptive cubic offset (both sides) → joins → caps → closed contour
 *
 * Applied only at export time — the viewport renders stroked paths via Canvas2D.
 */

import { computeSplineSegments, DEFAULT_TANGENCY } from './shapes.js';

/** Max offset approximation error before subdividing (font units). */
const OFFSET_TOL = 2.0;

/** Max recursion depth for adaptive cubic subdivision. */
const MAX_DEPTH = 4;

/** Max miter extension ratio (for polyline vertex joins). */
const MITER_LIMIT = 4;

/* ── Vector / curve math ─────────────────────────────────────── */

/** Unit normal pointing left of the direction a→b. */
function unitNormal(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: 0, y: -1 };
    return { x: -dy / len, y: dx / len };
}

/** Evaluate cubic bezier at parameter t. */
function evalCubic(p0, p1, p2, p3, t) {
    const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    return {
        x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
        y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
    };
}

/** Tangent vector of cubic bezier at parameter t. */
function cubicTangent(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
        x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
        y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
}

/** Unit normal of cubic at parameter t (left of direction of travel). */
function cubicNormalAt(p0, p1, p2, p3, t) {
    const tan = cubicTangent(p0, p1, p2, p3, t);
    const len = Math.hypot(tan.x, tan.y);
    if (len < 1e-9) return { x: 0, y: -1 };
    return { x: -tan.y / len, y: tan.x / len };
}

/** de Casteljau split at t=0.5 → two cubic halves. */
function subdivideCubic(p0, p1, p2, p3) {
    const a  = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const b  = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const c  = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
    const ab = { x: (a.x + b.x) / 2,   y: (a.y + b.y) / 2 };
    const bc = { x: (b.x + c.x) / 2,   y: (b.y + c.y) / 2 };
    const m  = { x: (ab.x + bc.x) / 2,  y: (ab.y + bc.y) / 2 };
    return [
        { p0, p1: a, p2: ab, p3: m },
        { p0: m, p1: bc, p2: c, p3 },
    ];
}

/* ── Centerline: shape → typed segments ──────────────────────── */

/**
 * Convert a shape's font-unit points into an array of typed segments:
 *   { type: 'line',  p0, p1 }
 *   { type: 'cubic', p0, p1, p2, p3 }
 */
function shapeToSegments(fontPts, type, tangency) {
    if (type === 'polyline') {
        return fontPts.slice(0, -1).map((p, i) => ({
            type: 'line', p0: p, p1: fontPts[i + 1],
        }));
    }

    // 2-point arc is just a line
    if (fontPts.length === 2) {
        return [{ type: 'line', p0: fontPts[0], p1: fontPts[1] }];
    }

    // Arc: Catmull-Rom spline → cubic bezier segments
    const segs = computeSplineSegments(fontPts, tangency ?? DEFAULT_TANGENCY);
    let prev = fontPts[0];
    return segs.map(s => {
        const seg = {
            type: 'cubic',
            p0: prev,
            p1: { x: s.cp1x, y: s.cp1y },
            p2: { x: s.cp2x, y: s.cp2y },
            p3: { x: s.ex, y: s.ey },
        };
        prev = seg.p3;
        return seg;
    });
}

/* ── Line offset (trivial) ───────────────────────────────────── */

function offsetLine(p0, p1, dist) {
    const n = unitNormal(p0.x, p0.y, p1.x, p1.y);
    return [{
        type: 'line',
        p0: { x: p0.x + n.x * dist, y: p0.y + n.y * dist },
        p1: { x: p1.x + n.x * dist, y: p1.y + n.y * dist },
    }];
}

/* ── Cubic offset (Tiller-Hanson + adaptive subdivision) ─────── */

/**
 * Naive offset: shift P0,P1 along the start-tangent normal,
 * P2,P3 along the end-tangent normal. Preserves tangent directions
 * at endpoints but may deviate in the interior.
 */
function offsetCubicNaive(p0, p1, p2, p3, dist) {
    let nStart = unitNormal(p0.x, p0.y, p1.x, p1.y);
    let nEnd   = unitNormal(p2.x, p2.y, p3.x, p3.y);

    // Degenerate tangent fallback (zero-length handle)
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-9) nStart = nEnd;
    if (Math.hypot(p3.x - p2.x, p3.y - p2.y) < 1e-9) nEnd = nStart;

    return {
        p0: { x: p0.x + nStart.x * dist, y: p0.y + nStart.y * dist },
        p1: { x: p1.x + nStart.x * dist, y: p1.y + nStart.y * dist },
        p2: { x: p2.x + nEnd.x * dist,   y: p2.y + nEnd.y * dist },
        p3: { x: p3.x + nEnd.x * dist,   y: p3.y + nEnd.y * dist },
    };
}

/**
 * Adaptive offset: try the naive offset, check error at sample points,
 * subdivide the original curve and recurse if error exceeds tolerance.
 */
function offsetCubicAdaptive(p0, p1, p2, p3, dist, tol, depth, result) {
    const q = offsetCubicNaive(p0, p1, p2, p3, dist);

    // Measure error at interior sample points
    let maxErr = 0;
    for (const t of [0.25, 0.5, 0.75]) {
        const orig  = evalCubic(p0, p1, p2, p3, t);
        const n     = cubicNormalAt(p0, p1, p2, p3, t);
        const trueX = orig.x + n.x * dist;
        const trueY = orig.y + n.y * dist;
        const approx = evalCubic(q.p0, q.p1, q.p2, q.p3, t);
        const err = Math.hypot(trueX - approx.x, trueY - approx.y);
        if (err > maxErr) maxErr = err;
    }

    if (maxErr <= tol || depth >= MAX_DEPTH) {
        result.push({ type: 'cubic', p0: q.p0, p1: q.p1, p2: q.p2, p3: q.p3 });
        return;
    }

    // Subdivide original at t=0.5 and recurse on each half
    const [left, right] = subdivideCubic(p0, p1, p2, p3);
    offsetCubicAdaptive(left.p0, left.p1, left.p2, left.p3, dist, tol, depth + 1, result);
    offsetCubicAdaptive(right.p0, right.p1, right.p2, right.p3, dist, tol, depth + 1, result);
}

/* ── Offset any segment ──────────────────────────────────────── */

function offsetSegment(seg, dist, tol) {
    if (seg.type === 'line') return offsetLine(seg.p0, seg.p1, dist);
    const result = [];
    offsetCubicAdaptive(seg.p0, seg.p1, seg.p2, seg.p3, dist, tol, 0, result);
    return result;
}

/* ── Segment start/end helpers ───────────────────────────────── */

function segStart(seg) { return seg.p0; }
function segEnd(seg)   { return seg.type === 'line' ? seg.p1 : seg.p3; }
function lastEl(arr)   { return arr[arr.length - 1]; }

function segStartNormal(seg) {
    if (seg.type === 'line') return unitNormal(seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y);
    return cubicNormalAt(seg.p0, seg.p1, seg.p2, seg.p3, 0);
}

function segEndNormal(seg) {
    if (seg.type === 'line') return unitNormal(seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y);
    return cubicNormalAt(seg.p0, seg.p1, seg.p2, seg.p3, 1);
}

/** Normalized tangent (direction of travel) at segment start. */
function segStartTangent(seg) {
    if (seg.type === 'line') {
        const dx = seg.p1.x - seg.p0.x, dy = seg.p1.y - seg.p0.y;
        const len = Math.hypot(dx, dy);
        return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
    }
    const t = cubicTangent(seg.p0, seg.p1, seg.p2, seg.p3, 0);
    const len = Math.hypot(t.x, t.y);
    return len < 1e-9 ? { x: 1, y: 0 } : { x: t.x / len, y: t.y / len };
}

/** Normalized tangent at segment end. */
function segEndTangent(seg) {
    if (seg.type === 'line') {
        const dx = seg.p1.x - seg.p0.x, dy = seg.p1.y - seg.p0.y;
        const len = Math.hypot(dx, dy);
        return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
    }
    const t = cubicTangent(seg.p0, seg.p1, seg.p2, seg.p3, 1);
    const len = Math.hypot(t.x, t.y);
    return len < 1e-9 ? { x: 1, y: 0 } : { x: t.x / len, y: t.y / len };
}

/* ── Inner offset trimming (self-intersection removal) ───────── */

/**
 * Classify a turn at the junction between two center segments.
 * Returns the cross product of end tangent × start tangent:
 *   > 0 → left turn (left is inner, right is outer)
 *   < 0 → right turn (right is inner, left is outer)
 */
function turnCross(prevCenterSeg, nextCenterSeg) {
    const t1 = segEndTangent(prevCenterSeg);
    const t2 = segStartTangent(nextCenterSeg);
    return t1.x * t2.y - t1.y * t2.x;
}

/** Line-line intersection: p1 + t*d1 = p2 + s*d2. Returns point or null. */
function lineLineIntersect(p1, d1, p2, d2) {
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-9) return null;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const t = (dx * d2.y - dy * d2.x) / denom;
    return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/**
 * Compute the inner trim point where two adjacent offset groups' edges
 * would intersect. This replaces the overshoot on the inner side of a turn.
 */
function innerTrimPoint(prevGroup, nextGroup, jc, halfW) {
    const endPt   = segEnd(lastEl(prevGroup));
    const startPt = segStart(nextGroup[0]);
    const endTan   = segEndTangent(lastEl(prevGroup));
    const startTan = segStartTangent(nextGroup[0]);

    const pt = lineLineIntersect(endPt, endTan, startPt, startTan);
    if (!pt) return null;

    // Reject if too far from junction (degenerate case)
    if (Math.hypot(pt.x - jc.x, pt.y - jc.y) > halfW * MITER_LIMIT) return null;
    return pt;
}

/* ── Circular arc → cubic bezier (for round caps / joins) ────── */

function arcToBeziers(cx, cy, r, startAngle, sweep) {
    const cmds = [];
    let remaining = sweep, a = startAngle;

    while (Math.abs(remaining) > 1e-6) {
        const step = Math.abs(remaining) > Math.PI / 2
            ? Math.sign(remaining) * Math.PI / 2
            : remaining;

        const alpha = (4 / 3) * Math.tan(step / 4);
        const c0 = Math.cos(a),        s0 = Math.sin(a);
        const c1 = Math.cos(a + step), s1 = Math.sin(a + step);

        cmds.push({
            cp1x: cx + r * (c0 - alpha * s0),
            cp1y: cy + r * (s0 + alpha * c0),
            cp2x: cx + r * (c1 + alpha * s1),
            cp2y: cy + r * (s1 - alpha * c1),
            x:    cx + r * c1,
            y:    cy + r * s1,
        });

        a += step;
        remaining -= step;
    }

    return cmds;
}

/* ── Caps ────────────────────────────────────────────────────── */

function addRoundCap(path, center, halfW, normalAngle, isEnd) {
    const fromAngle = isEnd ? normalAngle : (normalAngle + Math.PI);
    const arcs = arcToBeziers(center.x, center.y, halfW, fromAngle, -Math.PI);
    for (const a of arcs) {
        path.curveTo(a.cp1x, a.cp1y, a.cp2x, a.cp2y, a.x, a.y);
    }
}

function addSquareCap(path, center, halfW, dirAngle, normalAngle, isEnd) {
    const ext = isEnd ? 1 : -1;
    const dx = Math.cos(dirAngle) * halfW * ext;
    const dy = Math.sin(dirAngle) * halfW * ext;
    const cn = Math.cos(normalAngle), sn = Math.sin(normalAngle);

    if (isEnd) {
        path.lineTo(center.x + cn * halfW + dx, center.y + sn * halfW + dy);
        path.lineTo(center.x - cn * halfW + dx, center.y - sn * halfW + dy);
    } else {
        path.lineTo(center.x - cn * halfW + dx, center.y - sn * halfW + dy);
        path.lineTo(center.x + cn * halfW + dx, center.y + sn * halfW + dy);
    }
}

/* ── Joins (between consecutive center segments) ─────────────── */

/**
 * Add a round join arc between two offset endpoints on the same side.
 * Both points sit on a circle of radius halfW around the junction center.
 */
function addRoundJoin(path, center, halfW, fromPt, toPt) {
    const fromA = Math.atan2(fromPt.y - center.y, fromPt.x - center.x);
    let toA = Math.atan2(toPt.y - center.y, toPt.x - center.x);

    let sweep = toA - fromA;
    if (sweep > Math.PI)  sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;

    // Tiny angle → no visible join needed
    if (Math.abs(sweep) < 1e-3) return;

    const arcs = arcToBeziers(center.x, center.y, halfW, fromA, sweep);
    for (const a of arcs) {
        path.curveTo(a.cp1x, a.cp1y, a.cp2x, a.cp2y, a.x, a.y);
    }
}

/** Connect two offset endpoints — dispatches on lineJoin type. */
function addJoin(path, junctionCenter, halfW, fromPt, toPt, lineJoin) {
    const gap = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
    if (gap < 0.5) return; // close enough — no join geometry needed

    if (lineJoin === 'round') {
        addRoundJoin(path, junctionCenter, halfW, fromPt, toPt);
    } else if (lineJoin === 'miter') {
        // Compute miter point by intersecting the two offset edge directions
        const d1 = { x: fromPt.x - junctionCenter.x, y: fromPt.y - junctionCenter.y };
        const d2 = { x: toPt.x - junctionCenter.x, y: toPt.y - junctionCenter.y };
        // Use the incoming/outgoing tangent directions for the miter intersection
        // Direction along the from-edge (perpendicular to from→center)
        const fromDir = { x: -(fromPt.y - junctionCenter.y), y: fromPt.x - junctionCenter.x };
        const toDir   = { x: -(toPt.y - junctionCenter.y),   y: toPt.x - junctionCenter.x };
        const denom = fromDir.x * toDir.y - fromDir.y * toDir.x;
        if (Math.abs(denom) > 1e-9) {
            const dx = toPt.x - fromPt.x, dy = toPt.y - fromPt.y;
            const t = (dx * toDir.y - dy * toDir.x) / denom;
            const mx = fromPt.x + t * fromDir.x;
            const my = fromPt.y + t * fromDir.y;
            const miterDist = Math.hypot(mx - junctionCenter.x, my - junctionCenter.y);
            if (miterDist <= halfW * MITER_LIMIT) {
                path.lineTo(mx, my);
                path.lineTo(toPt.x, toPt.y);
                return;
            }
        }
        // Miter limit exceeded or degenerate — fall back to bevel
        path.lineTo(toPt.x, toPt.y);
    } else {
        // Bevel: straight line
        path.lineTo(toPt.x, toPt.y);
    }
}

/* ── Write a segment to the path (forward / reversed) ────────── */

function emitSeg(path, seg) {
    if (seg.type === 'line') {
        path.lineTo(seg.p1.x, seg.p1.y);
    } else {
        path.curveTo(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, seg.p3.x, seg.p3.y);
    }
}

function emitSegReversed(path, seg) {
    if (seg.type === 'line') {
        path.lineTo(seg.p0.x, seg.p0.y);
    } else {
        // Reverse cubic: swap endpoints and control points
        path.curveTo(seg.p2.x, seg.p2.y, seg.p1.x, seg.p1.y, seg.p0.x, seg.p0.y);
    }
}

/* ── Main: expand stroke → closed outline on an opentype.Path ── */

/**
 * Build a closed filled outline from centerline segments + stroke width.
 *
 * Outline winding (clockwise in Y-up, as OpenType expects):
 *   left forward → end cap → right backward → start cap → close
 *
 * @param {opentype.Path} path
 * @param {Array} centerSegs — typed segments ({ type, p0, p1, … })
 * @param {number} halfW — half stroke width in font units
 * @param {string} lineCap — 'round' | 'butt' | 'square'
 * @param {string} lineJoin — 'round' | 'miter' | 'bevel'
 */
export function expandStrokeToPath(path, centerSegs, halfW, lineCap, lineJoin) {
    if (centerSegs.length === 0) return;

    // Offset each center segment → arrays of offset segments per group
    const leftGroups  = centerSegs.map(seg => offsetSegment(seg,  halfW, OFFSET_TOL));
    const rightGroups = centerSegs.map(seg => offsetSegment(seg, -halfW, OFFSET_TOL));

    // Endpoint info for caps
    const firstCenter = centerSegs[0];
    const lastCenter  = lastEl(centerSegs);
    const startPt = firstCenter.p0;
    const endPt   = segEnd(lastCenter);

    const startN = segStartNormal(firstCenter);
    const endN   = segEndNormal(lastCenter);
    const startNAngle = Math.atan2(startN.y, startN.x);
    const endNAngle   = Math.atan2(endN.y, endN.x);
    const startDirA   = startNAngle - Math.PI / 2;
    const endDirA     = endNAngle   - Math.PI / 2;

    // ── 1. Start at first left offset point ──
    const firstLeftPt = segStart(leftGroups[0][0]);
    path.moveTo(firstLeftPt.x, firstLeftPt.y);

    // ── 2. Forward along left offset groups, with inner/outer-aware joins ──
    for (let g = 0; g < leftGroups.length; g++) {
        for (const seg of leftGroups[g]) emitSeg(path, seg);

        if (g < leftGroups.length - 1) {
            const fromPt = segEnd(lastEl(leftGroups[g]));
            const toPt   = segStart(leftGroups[g + 1][0]);
            const jc     = segEnd(centerSegs[g]);
            const cross  = turnCross(centerSegs[g], centerSegs[g + 1]);

            if (cross > 0.01) {
                // Left turn → left is inner: trim to intersection
                const trim = innerTrimPoint(leftGroups[g], leftGroups[g + 1], jc, halfW);
                path.lineTo(trim ? trim.x : toPt.x, trim ? trim.y : toPt.y);
                if (trim) path.lineTo(toPt.x, toPt.y);
            } else if (cross < -0.01) {
                // Right turn → left is outer: regular join
                addJoin(path, jc, halfW, fromPt, toPt, lineJoin);
            } else {
                // Nearly straight — connect if gap exists
                if (Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y) > 0.5)
                    path.lineTo(toPt.x, toPt.y);
            }
        }
    }

    // ── 3. End cap ──
    if (lineCap === 'round') {
        addRoundCap(path, endPt, halfW, endNAngle, true);
    } else if (lineCap === 'square') {
        addSquareCap(path, endPt, halfW, endDirA, endNAngle, true);
    } else {
        // Butt: straight to right side
        const lastRightPt = segEnd(lastEl(rightGroups[rightGroups.length - 1]));
        path.lineTo(lastRightPt.x, lastRightPt.y);
    }

    // ── 4. Backward along right offset groups, with inner/outer-aware joins ──
    for (let g = rightGroups.length - 1; g >= 0; g--) {
        const group = rightGroups[g];
        for (let s = group.length - 1; s >= 0; s--) emitSegReversed(path, group[s]);

        if (g > 0) {
            const fromPt = segStart(rightGroups[g][0]);
            const toPt   = segEnd(lastEl(rightGroups[g - 1]));
            const jc     = centerSegs[g].p0;
            const cross  = turnCross(centerSegs[g - 1], centerSegs[g]);

            if (cross < -0.01) {
                // Right turn → right is inner: trim to intersection
                const trim = innerTrimPoint(rightGroups[g - 1], rightGroups[g], jc, halfW);
                path.lineTo(trim ? trim.x : toPt.x, trim ? trim.y : toPt.y);
                if (trim) path.lineTo(toPt.x, toPt.y);
            } else if (cross > 0.01) {
                // Left turn → right is outer: regular join
                addJoin(path, jc, halfW, fromPt, toPt, lineJoin);
            } else {
                if (Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y) > 0.5)
                    path.lineTo(toPt.x, toPt.y);
            }
        }
    }

    // ── 5. Start cap ──
    if (lineCap === 'round') {
        addRoundCap(path, startPt, halfW, startNAngle, false);
    } else if (lineCap === 'square') {
        addSquareCap(path, startPt, halfW, startDirA, startNAngle, false);
    }

    // ── 6. Close ──
    path.closePath();
}

/* ── Point resolution helpers ────────────────────────────────── */

/**
 * Resolve a shape's points to font units, applying deformed overrides.
 * @param {object} shape — shape with .id and .points (0–1 fractions)
 * @param {number} upm — unitsPerEm
 * @param {object|null} deformed — deformedSnapshot: { [shapeId]: { [ptIndex]: {x,y} } }
 * @param {number} xShift — horizontal shift in font units (for bearing alignment)
 */
function resolveToFontUnits(shape, upm, deformed, xShift) {
    return shape.points.map((p, i) => {
        const ov = deformed?.[shape.id]?.[i];
        const x = ov ? ov.x : p.x;
        const y = ov ? ov.y : p.y;
        return { x: x * upm + xShift, y: (1 - y) * upm };
    });
}

/** Reverse a segment (swap direction). */
function reverseSegment(seg) {
    if (seg.type === 'line') {
        return { type: 'line', p0: seg.p1, p1: seg.p0 };
    }
    return { type: 'cubic', p0: seg.p3, p1: seg.p2, p2: seg.p1, p3: seg.p0 };
}

/* ── Public API ──────────────────────────────────────────────── */

/**
 * Expand a single (unchained) shape's stroke into a closed outline.
 * Handles polylines and arcs. (Dots are filled outlines — handled separately.)
 *
 * @param {opentype.Path} path
 * @param {object} shape — from ShapeEditor
 * @param {number} unitsPerEm
 * @param {object|null} deformed — deformedSnapshot from letterStore
 * @param {number} [xShift=0] — horizontal shift in font units (bearing alignment)
 */
export function expandShapeToOutline(path, shape, unitsPerEm, deformed, xShift = 0) {
    const fontPts = resolveToFontUnits(shape, unitsPerEm, deformed, xShift);
    const segments = shapeToSegments(fontPts, shape.type, shape.tangency);
    if (segments.length === 0) return;

    expandStrokeToPath(
        path, segments, shape.strokeWidth / 2,
        shape.lineCap || 'round', shape.lineJoin || 'round',
    );
}

/**
 * Expand a chain of joined shapes as a single continuous outline.
 * Produces one closed contour with caps only at the chain's true endpoints
 * (no internal caps at junctions between shapes).
 *
 * @param {opentype.Path} path
 * @param {Array<{shapeId: number, reversed: boolean}>} chain — from buildJoinChains
 * @param {Array} shapes — all shape objects for this letter
 * @param {number} unitsPerEm
 * @param {object|null} deformed — deformedSnapshot from letterStore
 * @param {number} [xShift=0] — horizontal shift in font units (bearing alignment)
 */
export function expandChainToOutline(path, chain, shapes, unitsPerEm, deformed, xShift = 0) {
    const allSegments = [];
    let strokeWidth = 30;
    let lineCap = 'round';
    let lineJoin = 'round';

    for (const { shapeId, reversed } of chain) {
        const shape = shapes.find(s => s.id === shapeId);
        if (!shape) continue;

        // Use the first shape's stroke properties for the whole chain
        if (allSegments.length === 0) {
            strokeWidth = shape.strokeWidth;
            lineCap  = shape.lineCap  || 'round';
            lineJoin = shape.lineJoin || 'round';
        }

        const fontPts = resolveToFontUnits(shape, unitsPerEm, deformed, xShift);
        let segs = shapeToSegments(fontPts, shape.type, shape.tangency);

        if (reversed) segs = segs.reverse().map(reverseSegment);

        allSegments.push(...segs);
    }

    if (allSegments.length === 0) return;

    expandStrokeToPath(
        path, allSegments, strokeWidth / 2,
        lineCap, lineJoin,
    );
}
