/**
 * svgExport.js — Batch SVG export
 * Exports each designed glyph as an individual SVG file with a fixed-size
 * canvas and consistent stroke positioning across all letters.
 * Uses the deformed snapshot captured at save time so the SVG shows
 * the letter as it appeared in the viewport when saved.
 * Joined endpoints produce continuous paths (no endcap blobs at junctions).
 */

import { computeSplineSegments, DEFAULT_TANGENCY, buildJoinChains } from './shapes.js';

/** Fixed canvas size for every exported SVG. */
const SVG_W = 1000;
const SVG_H = 1000;

/**
 * Resolve a shape's points to SVG coords, applying deformed overrides.
 */
function resolvePoints(shape, w, h, deformed) {
    return shape.points.map((p, i) => {
        const override = deformed?.[shape.id]?.[i];
        return {
            x: (override ? override.x : p.x) * w,
            y: (override ? override.y : p.y) * h,
        };
    });
}

/**
 * Build SVG path data (d attribute) for a shape's points.
 * If isFirst is false, omits the initial M command (continues from previous segment).
 */
function shapePathData(pts, shape, isFirst) {
    if (pts.length < 2) return '';
    let d = '';
    if (isFirst) {
        d += `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
    }

    if (shape.type === 'arc') {
        if (pts.length === 2) {
            d += ` L${pts[1].x.toFixed(2)},${pts[1].y.toFixed(2)}`;
        } else {
            const tension = shape.tangency ?? DEFAULT_TANGENCY;
            const segs = computeSplineSegments(pts, tension);
            for (const s of segs) {
                d += ` C${s.cp1x.toFixed(2)},${s.cp1y.toFixed(2)} ${s.cp2x.toFixed(2)},${s.cp2y.toFixed(2)} ${s.ex.toFixed(2)},${s.ey.toFixed(2)}`;
            }
        }
    } else {
        // polyline
        for (let i = 1; i < pts.length; i++) {
            d += ` L${pts[i].x.toFixed(2)},${pts[i].y.toFixed(2)}`;
        }
    }
    return d;
}

/**
 * Build SVG element for a single standalone shape.
 */
function shapeToSVGElement(shape, pts) {
    if (shape.type === 'dot' && pts.length >= 1) {
        const r = shape.strokeWidth / 2;
        return `  <circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="${r}" fill="#000" />`;
    }
    if (pts.length < 2) return '';
    const d = shapePathData(pts, shape, true);
    return `  <path d="${d}" fill="none" stroke="#000" stroke-width="${shape.strokeWidth}" stroke-linecap="${shape.lineCap || 'round'}" stroke-linejoin="${shape.lineJoin || 'round'}" />`;
}

/**
 * Build SVG element for a chain of joined shapes (single continuous path).
 */
function chainToSVGElement(chain, shapes, w, h, deformed) {
    const firstShape = shapes.find((s) => s.id === chain[0].shapeId);
    if (!firstShape) return '';

    let d = '';
    for (let ci = 0; ci < chain.length; ci++) {
        const { shapeId, reversed } = chain[ci];
        const shape = shapes.find((s) => s.id === shapeId);
        if (!shape) continue;
        let pts = resolvePoints(shape, w, h, deformed);
        if (reversed) pts = [...pts].reverse();
        d += shapePathData(pts, shape, ci === 0);
    }

    return `  <path d="${d}" fill="none" stroke="#000" stroke-width="${firstShape.strokeWidth}" stroke-linecap="${firstShape.lineCap || 'round'}" stroke-linejoin="${firstShape.lineJoin || 'round'}" />`;
}

/**
 * Generate a complete SVG string for one glyph.
 */
function generateSVG(letterData, char) {
    const W = SVG_W;
    const H = SVG_H;
    const deformed = letterData.deformedSnapshot;
    const joinFlags = letterData.joinFlags || [];
    const bindings = letterData.bindings || {};
    const getBinding = (sid, pidx) => bindings[`${sid}:${pidx}`] ?? null;
    const { chains, chainedIds } = buildJoinChains(letterData.shapes, joinFlags, getBinding);

    let shapesSVG = '';

    // Chains → continuous paths
    for (const chain of chains) {
        shapesSVG += chainToSVGElement(chain, letterData.shapes, W, H, deformed) + '\n';
    }

    // Unchained shapes → individual elements
    for (const shape of letterData.shapes) {
        if (chainedIds.has(shape.id)) continue;
        const pts = resolvePoints(shape, W, H, deformed);
        shapesSVG += shapeToSVGElement(shape, pts) + '\n';
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <g id="glyph">
${shapesSVG}  </g>
</svg>`;
}

function downloadSVG(svgString, filename) {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Export all designed glyphs as individual SVG files.
 * Each SVG uses the deformedSnapshot saved with the letter (the pose
 * captured at save time), so the export matches what the user saw.
 */
export function exportSVGs(letterStore) {
    const chars = letterStore.getStoredChars();
    let exported = 0;

    chars.forEach((char, i) => {
        const data = letterStore.getLetter(char);
        if (!data?.shapes?.length) return;

        setTimeout(() => {
            const svg = generateSVG(data, char);
            const safeName = char.charCodeAt(0).toString(16).padStart(4, '0');
            downloadSVG(svg, `glyph-${char}-${safeName}.svg`);
        }, i * 150);

        exported++;
    });

    return exported;
}
