/**
 * viewportRenderer.js — Viewport shape rendering
 * Draws glyph shapes on the main viewport canvas, handling both live
 * deformed previews and stored letter playback. Joined shapes render
 * as continuous paths (no endcap blobs at junctions).
 */

import { computeSplineSegments, DEFAULT_TANGENCY, buildJoinChains } from './shapes.js';

/** Draw a smooth spline through points using shared computeSplineSegments. */
function _drawSplineCtx(ctx, pts, tension, closed = false) {
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2 && !closed) {
        ctx.lineTo(pts[1].x, pts[1].y);
        return;
    }
    const segs = computeSplineSegments(pts, tension, closed);
    for (const s of segs) {
        ctx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.ex, s.ey);
    }
}

/**
 * Resolve a shape's points to pixel coords, applying deformed overrides.
 */
export function resolvePoints(shape, vw, vh, deformedPoints) {
    return shape.points.map((p, i) => {
        const override = deformedPoints?.[shape.id]?.[i];
        return {
            x: (override ? override.x : p.x) * vw,
            y: (override ? override.y : p.y) * vh,
        };
    });
}

/**
 * Draw a single shape segment onto an already-open path (no beginPath/stroke).
 * If isFirst is true, starts with moveTo; otherwise continues from current point.
 */
function drawShapeSegment(vCtx, pts, shape, isFirst) {
    if (isFirst) {
        vCtx.moveTo(pts[0].x, pts[0].y);
    }

    if (shape.type === 'arc' && pts.length >= 2) {
        if (pts.length === 2 && !shape.closed) {
            vCtx.lineTo(pts[1].x, pts[1].y);
        } else {
            const segs = computeSplineSegments(pts, shape.tangency ?? DEFAULT_TANGENCY, shape.closed);
            for (let i = 0; i < segs.length; i++) {
                const s = segs[i];
                vCtx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.ex, s.ey);
            }
        }
    } else {
        // Polyline (or fallback)
        for (let i = 1; i < pts.length; i++) {
            vCtx.lineTo(pts[i].x, pts[i].y);
        }
    }
}

/**
 * Draw a single standalone shape (not part of a chain).
 */
export function drawSingleShape(vCtx, shape, pts) {
    vCtx.save();
    vCtx.strokeStyle = '#000';
    vCtx.fillStyle   = '#000';
    vCtx.lineWidth   = shape.strokeWidth;
    vCtx.lineCap     = shape.lineCap || 'round';
    vCtx.lineJoin    = shape.lineJoin || 'round';

    if (shape.type === 'dot' && pts.length >= 1) {
        vCtx.beginPath();
        vCtx.arc(pts[0].x, pts[0].y, shape.strokeWidth / 2, 0, Math.PI * 2);
        vCtx.fill();
    } else if (shape.type === 'arc' && pts.length >= 2) {
        vCtx.beginPath();
        _drawSplineCtx(vCtx, pts, shape.tangency ?? DEFAULT_TANGENCY, shape.closed);
        vCtx.stroke();
    } else if (shape.type === 'polyline' && pts.length >= 2) {
        vCtx.beginPath();
        vCtx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) vCtx.lineTo(pts[i].x, pts[i].y);
        if (shape.closed) vCtx.closePath();
        vCtx.stroke();
    }
    vCtx.restore();
}

/**
 * Draw a chain of joined shapes as a single continuous path.
 */
function drawChain(vCtx, chain, shapes, vw, vh, deformedPoints) {
    const firstShape = shapes.find((s) => s.id === chain[0].shapeId);
    if (!firstShape) return;

    vCtx.save();
    vCtx.strokeStyle = '#000';
    vCtx.lineWidth   = firstShape.strokeWidth;
    vCtx.lineCap     = firstShape.lineCap || 'round';
    vCtx.lineJoin    = firstShape.lineJoin || 'round';
    vCtx.beginPath();

    for (let ci = 0; ci < chain.length; ci++) {
        const { shapeId, reversed } = chain[ci];
        const shape = shapes.find((s) => s.id === shapeId);
        if (!shape) continue;
        let pts = resolvePoints(shape, vw, vh, deformedPoints);
        if (reversed) pts = [...pts].reverse();
        drawShapeSegment(vCtx, pts, shape, ci === 0);
    }
    vCtx.stroke();
    vCtx.restore();
}

/**
 * Draw shapes on the viewport letter canvas (deformed preview).
 * Joined shapes are rendered as continuous paths (no endcaps at junctions).
 *
 * @param {CanvasRenderingContext2D} vCtx
 * @param {number} vw — canvas width
 * @param {number} vh — canvas height
 * @param {object|null} deformedPoints — binding override positions
 * @param {Array} shapes — shape objects
 * @param {Array} joinFlags — array of "shapeId:pointIndex" strings
 * @param {function} getBinding — (shapeId, pointIndex) => keypoint name or null
 */
export function drawShapesOnViewport(vCtx, vw, vh, deformedPoints, shapes, joinFlags, getBinding) {
    const { chains, chainedIds } = buildJoinChains(shapes, joinFlags, getBinding);

    for (const chain of chains) {
        drawChain(vCtx, chain, shapes, vw, vh, deformedPoints);
    }

    for (const shape of shapes) {
        if (chainedIds.has(shape.id)) continue;
        const pts = resolvePoints(shape, vw, vh, deformedPoints);
        drawSingleShape(vCtx, shape, pts);
    }
}

/**
 * Draw a stored letter's shapes on the viewport using its saved deformedSnapshot.
 * Used in alphabet tab to preview the letter as it looked when saved.
 */
export function drawStoredLetterOnViewport(vCtx, vw, vh, letterData) {
    const deformed = letterData.deformedSnapshot;
    const joinFlags = letterData.joinFlags || [];
    const bindings = letterData.bindings || {};
    const getBinding = (sid, pidx) => bindings[`${sid}:${pidx}`] ?? null;
    const { chains, chainedIds } = buildJoinChains(letterData.shapes, joinFlags, getBinding);

    for (const chain of chains) {
        drawChain(vCtx, chain, letterData.shapes, vw, vh, deformed);
    }

    for (const shape of letterData.shapes) {
        if (chainedIds.has(shape.id)) continue;
        const pts = resolvePoints(shape, vw, vh, deformed);
        drawSingleShape(vCtx, shape, pts);
    }
}
