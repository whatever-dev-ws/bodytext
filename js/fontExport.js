/**
 * fontExport.js — OTF font generation
 * Converts stored letter data to a downloadable .otf font file via opentype.js.
 * Expects the `opentype` global from CDN.
 *
 * Stroke expansion: polylines and arcs are expanded from centerline strokes
 * into closed filled outlines at export time (via strokeExpand.js).
 * Dots are emitted as filled bezier circles directly.
 *
 * Uses each letter's deformedSnapshot (the pose captured at save time) so the
 * exported font matches what the user saw in the viewport.
 * Joined shapes are exported as single continuous outlines (no internal caps).
 */

import { expandShapeToOutline, expandChainToOutline } from './strokeExpand.js';
import { buildJoinChains } from './shapes.js';

/**
 * Convert a letter's shapes into an opentype.js Path with filled outlines.
 *
 * The xShift parameter aligns the left bearing guide to x=0 in glyph space,
 * so bearing lines act as the advance width boundaries.
 *
 * @param {Array} shapes — shape objects from ShapeEditor
 * @param {number} unitsPerEm
 * @param {object|null} deformed — deformedSnapshot: { [shapeId]: { [ptIdx]: {x,y} } }
 * @param {Array|null} joinFlags — array of "shapeId:pointIndex" strings
 * @param {object|null} bindings — { "shapeId:pointIndex": keypointName }
 * @param {number} xShift — horizontal shift to align left bearing to x=0
 * @returns {opentype.Path}
 */
export function shapesToPath(shapes, unitsPerEm, deformed, joinFlags, bindings, xShift) {
    const path = new opentype.Path();

    // Build join chains (continuous multi-shape paths)
    const getBinding = (sid, pidx) => bindings?.[`${sid}:${pidx}`] ?? null;
    const { chains, chainedIds } = buildJoinChains(shapes, joinFlags || [], getBinding);

    // Chains → single continuous outlines (no internal caps)
    for (const chain of chains) {
        expandChainToOutline(path, chain, shapes, unitsPerEm, deformed, xShift);
    }

    // Unchained shapes → individual outlines
    for (const shape of shapes) {
        if (chainedIds.has(shape.id)) continue;

        if (shape.type === 'dot' && shape.points.length >= 1) {
            // Dot → filled circle approximated with 4 cubic bezier arcs
            const ov = deformed?.[shape.id]?.[0];
            const px = ov ? ov.x : shape.points[0].x;
            const py = ov ? ov.y : shape.points[0].y;
            const cx = px * unitsPerEm + xShift;
            const cy = (1 - py) * unitsPerEm;
            const r  = (shape.strokeWidth || 30) / 2;
            const k  = r * 0.5523; // (4/3)*tan(π/8) — bezier circle constant
            path.moveTo(cx - r, cy);
            path.curveTo(cx - r, cy + k, cx - k, cy + r, cx, cy + r);
            path.curveTo(cx + k, cy + r, cx + r, cy + k, cx + r, cy);
            path.curveTo(cx + r, cy - k, cx + k, cy - r, cx, cy - r);
            path.curveTo(cx - k, cy - r, cx - r, cy - k, cx - r, cy);
            path.closePath();
        } else if (shape.points.length >= 2) {
            // Polyline / arc → expand centerline stroke into filled outline
            expandShapeToOutline(path, shape, unitsPerEm, deformed, xShift);
        }
    }

    return path;
}

/**
 * Export all stored letters as a .otf font file.
 *
 * @param {import('./letterStore.js').LetterStore} letterStore
 * @param {object} [metrics] — font metrics in font units
 * @param {number} [metrics.ascender=800]  — distance above baseline
 * @param {number} [metrics.descender=200] — distance below baseline (positive; negated internally)
 * @param {number} [metrics.xHeight]       — OS/2 sxHeight (e.g. 500)
 * @param {number} [metrics.capHeight]     — OS/2 sCapHeight (e.g. 700)
 * @param {string} [fontFamily='bodyText'] — font family name
 */
export function exportOTF(letterStore, metrics, fontFamily = 'bodyText') {
    const ascender   = metrics?.ascender   ?? 800;
    const descender  = metrics?.descender  ?? 200;
    const unitsPerEm = 1000;

    // Create notdef glyph (required)
    const notdefPath = new opentype.Path();
    notdefPath.moveTo(100, 0);
    notdefPath.lineTo(100, ascender);
    notdefPath.lineTo(500, ascender);
    notdefPath.lineTo(500, 0);
    notdefPath.closePath();
    const notdefGlyph = new opentype.Glyph({
        name: '.notdef',
        unicode: 0,
        advanceWidth: 650,
        path: notdefPath,
    });

    const glyphs = [notdefGlyph];

    for (const char of letterStore.getStoredChars()) {
        const data = letterStore.getLetter(char);
        if (!data?.shapes?.length) continue;

        // Per-letter bearing → proportional advance width
        const bL = (data.bearingLeft ?? metrics?.bearingLeft ?? 10) / 100;
        const bR = (data.bearingRight ?? metrics?.bearingRight ?? 10) / 100;
        const xShift = -bL * unitsPerEm;
        const advanceWidth = Math.round((1 - bL - bR) * unitsPerEm);

        const path = shapesToPath(
            data.shapes, unitsPerEm,
            data.deformedSnapshot,
            data.joinFlags,
            data.bindings,
            xShift,
        );
        const glyph = new opentype.Glyph({
            name: char,
            unicode: char.charCodeAt(0),
            advanceWidth: advanceWidth,
            path: path,
        });
        glyphs.push(glyph);
    }

    const font = new opentype.Font({
        familyName: fontFamily,
        styleName: 'Regular',
        unitsPerEm: unitsPerEm,
        ascender: ascender,
        descender: -descender,
        glyphs: glyphs,
    });

    // Embed additional metrics in the OS/2 table if provided
    if (metrics?.xHeight != null) {
        font.tables.os2.sxHeight = metrics.xHeight;
    }
    if (metrics?.capHeight != null) {
        font.tables.os2.sCapHeight = metrics.capHeight;
    }

    font.download(`${fontFamily}.otf`);
}
