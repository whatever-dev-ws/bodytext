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

/* ── Drag / hover state (module-level for draw feedback) ──────────────── */

let _activeGuide = null;   // guideState key of guide being hovered or dragged

/**
 * Derive the five horizontal guide lines from the current state.
 * Each entry has { key, name, frac (0–1 of canvas height), color }.
 */
export function getGuideLines(state = guideState) {
    const bl = state.baseline / 100;

    return [
        { key: 'ascender',  name: 'Ascender',  frac: bl - state.ascender  / UPM, color: '#E53935' },
        { key: 'capHeight', name: 'Cap',       frac: bl - state.capHeight  / UPM, color: '#FB8C00' },
        { key: 'xHeight',   name: 'x-Height',  frac: bl - state.xHeight    / UPM, color: '#43A047' },
        { key: 'baseline',  name: 'Baseline',  frac: bl,                           color: '#1446FF' },
        { key: 'descender', name: 'Descender', frac: bl + state.descender  / UPM, color: '#8E24AA' },
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
        const active = _activeGuide === guide.key;

        gCtx.beginPath();
        gCtx.strokeStyle = guide.color;
        gCtx.lineWidth   = active ? 2.5 : 1;
        gCtx.moveTo(0, y);
        gCtx.lineTo(w, y);
        gCtx.stroke();

        gCtx.fillStyle = guide.color;
        gCtx.font = active ? 'bold 11px sans-serif' : '11px sans-serif';
        gCtx.fillText(guide.name, 8, y - 4);
    }

    // Vertical side bearings
    const leftX  = (state.bearingLeft / 100) * w;
    const rightX = w - (state.bearingRight / 100) * w;

    for (const [key, x] of [['bearingLeft', leftX], ['bearingRight', rightX]]) {
        const active = _activeGuide === key;
        gCtx.strokeStyle = active ? 'rgba(20, 70, 255, 0.6)' : 'rgba(20, 70, 255, 0.35)';
        gCtx.lineWidth   = active ? 2.5 : 1;
        gCtx.beginPath();
        gCtx.moveTo(x, 0);
        gCtx.lineTo(x, h);
        gCtx.stroke();
    }

    gCtx.restore();
}

/* ── Viewport drag interaction ────────────────────────────────────────── */

const HIT_RADIUS = 8;

/** Slider/input DOM refs — resolved lazily on first use. */
let _sliderRefs = null;

function getSliderRefs() {
    if (_sliderRefs) return _sliderRefs;
    _sliderRefs = {
        baseline:     { slider: document.getElementById('guide-baseline-slider'),      input: document.getElementById('guide-baseline-value') },
        ascender:     { slider: document.getElementById('guide-ascender-slider'),      input: document.getElementById('guide-ascender-value') },
        capHeight:    { slider: document.getElementById('guide-cap-slider'),           input: document.getElementById('guide-cap-value') },
        xHeight:      { slider: document.getElementById('guide-xheight-slider'),       input: document.getElementById('guide-xheight-value') },
        descender:    { slider: document.getElementById('guide-descender-slider'),     input: document.getElementById('guide-descender-value') },
        bearingLeft:  { slider: document.getElementById('guide-bearing-left-slider'),  input: document.getElementById('guide-bearing-left-value') },
        bearingRight: { slider: document.getElementById('guide-bearing-right-slider'), input: document.getElementById('guide-bearing-right-value') },
    };
    return _sliderRefs;
}

function syncSlider(key) {
    const { slider, input } = getSliderRefs()[key];
    const val = guideState[key];
    slider.value = val;
    input.value  = val;
}

function enforceConstraints() {
    if (guideState.ascender + guideState.descender > UPM) {
        guideState.descender = UPM - guideState.ascender;
        if (guideState.descender < 0) { guideState.descender = 0; guideState.ascender = UPM; }
        syncSlider('descender');
        syncSlider('ascender');
    }
    if (guideState.capHeight > guideState.ascender) {
        guideState.capHeight = guideState.ascender;
        syncSlider('capHeight');
    }
    if (guideState.xHeight > guideState.capHeight) {
        guideState.xHeight = guideState.capHeight;
        syncSlider('xHeight');
    }
    const statusEl = document.getElementById('guide-upm-status');
    if (statusEl) {
        const total = guideState.ascender + guideState.descender;
        statusEl.textContent = `${guideState.ascender} + ${guideState.descender} = ${total} / ${UPM}`;
        statusEl.style.color = total > UPM ? '#E53935' : '';
    }
}

function hitTest(mx, my, w, h) {
    const bl = guideState.baseline / 100;
    const targets = [
        { key: 'ascender',     pos: (bl - guideState.ascender  / UPM) * h, type: 'h' },
        { key: 'capHeight',    pos: (bl - guideState.capHeight / UPM) * h, type: 'h' },
        { key: 'xHeight',      pos: (bl - guideState.xHeight  / UPM) * h, type: 'h' },
        { key: 'baseline',     pos: bl * h,                                type: 'h' },
        { key: 'descender',    pos: (bl + guideState.descender / UPM) * h, type: 'h' },
        { key: 'bearingLeft',  pos: (guideState.bearingLeft  / 100) * w,   type: 'v' },
        { key: 'bearingRight', pos: w - (guideState.bearingRight / 100) * w, type: 'v' },
    ];

    let closest = null;
    let minDist = HIT_RADIUS;
    for (const t of targets) {
        const dist = t.type === 'h' ? Math.abs(my - t.pos) : Math.abs(mx - t.pos);
        if (dist < minDist) {
            minDist = dist;
            closest = t;
        }
    }
    return closest;
}

function applyDrag(key, mx, my, w, h) {
    const bl = guideState.baseline / 100;

    switch (key) {
        case 'baseline':
            guideState.baseline = Math.round(Math.max(0, Math.min(100, (my / h) * 100)));
            break;
        case 'ascender':
            guideState.ascender = Math.round(Math.max(0, Math.min(UPM, (bl - my / h) * UPM)));
            break;
        case 'capHeight':
            guideState.capHeight = Math.round(Math.max(0, Math.min(UPM, (bl - my / h) * UPM)));
            break;
        case 'xHeight':
            guideState.xHeight = Math.round(Math.max(0, Math.min(UPM, (bl - my / h) * UPM)));
            break;
        case 'descender':
            guideState.descender = Math.round(Math.max(0, Math.min(UPM, (my / h - bl) * UPM)));
            break;
        case 'bearingLeft':
            guideState.bearingLeft = Math.round(Math.max(0, Math.min(40, (mx / w) * 100)));
            break;
        case 'bearingRight':
            guideState.bearingRight = Math.round(Math.max(0, Math.min(40, (1 - mx / w) * 100)));
            break;
    }
    syncSlider(key);
}

/**
 * Wire mouse handlers on the viewport guides canvas so guide lines
 * can be dragged directly. Values sync back to the sidebar sliders.
 *
 * @param {HTMLCanvasElement} canvas — the #canvas-guides element
 * @param {object} appState — the shared mutable state (reads showGuides)
 * @param {Function} markDirty — signal that a redraw is needed
 */
export function initGuideDrag(canvas, appState, markDirty) {
    let dragging = null;

    function canvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const sx = canvas.width  / rect.width;
        const sy = canvas.height / rect.height;
        return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    }

    canvas.addEventListener('mousedown', (e) => {
        if (!appState.showGuides) return;
        const { x, y } = canvasCoords(e);
        const hit = hitTest(x, y, canvas.width, canvas.height);
        if (hit) {
            dragging = hit.key;
            _activeGuide = hit.key;
            e.preventDefault();
            markDirty();
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!appState.showGuides) {
            if (_activeGuide) { _activeGuide = null; canvas.style.cursor = ''; markDirty(); }
            return;
        }
        const { x, y } = canvasCoords(e);

        if (dragging) {
            applyDrag(dragging, x, y, canvas.width, canvas.height);
            enforceConstraints();
            markDirty();
            return;
        }

        // Hover detection for cursor + visual feedback
        const hit = hitTest(x, y, canvas.width, canvas.height);
        const newHover = hit ? hit.key : null;
        if (newHover !== _activeGuide) {
            _activeGuide = newHover;
            canvas.style.cursor = hit ? (hit.type === 'h' ? 'ns-resize' : 'ew-resize') : '';
            markDirty();
        }
    });

    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = null;
            _activeGuide = null;
            canvas.style.cursor = '';
            markDirty();
        }
    });

    canvas.addEventListener('mouseleave', () => {
        if (!dragging && _activeGuide) {
            _activeGuide = null;
            canvas.style.cursor = '';
            markDirty();
        }
    });
}
