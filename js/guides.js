/**
 * guides.js — Typographic guide lines and side bearings.
 *
 * The baseline is positioned freely on the canvas (as a percentage
 * of canvas height). All other horizontal guides are offsets from
 * the baseline, measured in font units (UPM = 1000).
 *
 * 1 font unit = canvasHeight / UPM pixels, so the full 1000 units
 * spans exactly the canvas height. The constraint
 * ascender + descender ≤ UPM prevents guides from overlapping.
 *
 * Side bearings are percentages inset from the canvas edges.
 */

export const UPM = 1000;

export const guideState = {
    baseline:    72,    // % of canvas height (where baseline sits)
    ascender:    800,   // font units above baseline
    capHeight:   700,   // font units above baseline
    xHeight:     500,   // font units above baseline
    descender:   200,   // font units below baseline
    bearingLeft:  10,   // % from left edge
    bearingRight: 10,   // % from right edge
};

/**
 * Derive the five horizontal guide lines from the current state.
 * Each entry has { name, frac (0–1 of canvas height), color }.
 *
 * Mapping: baseline sits at (baseline / 100).
 * 1 font unit = 1/UPM of canvas height.
 * Ascender line = baseline_frac - ascender/UPM
 * Descender line = baseline_frac + descender/UPM
 */
export function getGuideLines(state = guideState) {
    const bl = state.baseline / 100;

    return [
        { name: 'Ascender',  frac: bl - state.ascender  / UPM, color: '#E53935' },
        { name: 'Cap',       frac: bl - state.capHeight  / UPM, color: '#FB8C00' },
        { name: 'x-Height',  frac: bl - state.xHeight    / UPM, color: '#43A047' },
        { name: 'Baseline',  frac: bl,                           color: '#1446FF' },
        { name: 'Descender', frac: bl + state.descender  / UPM, color: '#8E24AA' },
    ];
}

/**
 * Draw horizontal guide lines and vertical side bearings.
 * @param {CanvasRenderingContext2D} gCtx
 * @param {number} w — canvas width
 * @param {number} h — canvas height
 * @param {object} [state] — defaults to the module-level guideState
 */
export function drawGuides(gCtx, w, h, state = guideState) {
    gCtx.save();

    // Horizontal guide lines
    for (const guide of getGuideLines(state)) {
        const y = guide.frac * h;
        gCtx.beginPath();
        gCtx.strokeStyle = guide.color;
        gCtx.lineWidth   = 1;
        gCtx.setLineDash([6, 4]);
        gCtx.moveTo(0, y);
        gCtx.lineTo(w, y);
        gCtx.stroke();
        gCtx.setLineDash([]);

        gCtx.fillStyle = guide.color;
        gCtx.font = '11px sans-serif';
        gCtx.fillText(guide.name, 8, y - 4);
    }

    // Vertical side bearings
    const bearingColor = 'rgba(20, 70, 255, 0.35)';
    const leftX  = (state.bearingLeft / 100) * w;
    const rightX = w - (state.bearingRight / 100) * w;

    gCtx.strokeStyle = bearingColor;
    gCtx.lineWidth   = 1;
    gCtx.setLineDash([4, 4]);

    gCtx.beginPath();
    gCtx.moveTo(leftX, 0);
    gCtx.lineTo(leftX, h);
    gCtx.stroke();

    gCtx.beginPath();
    gCtx.moveTo(rightX, 0);
    gCtx.lineTo(rightX, h);
    gCtx.stroke();

    gCtx.setLineDash([]);
    gCtx.restore();
}
