/**
 * gridCapture.js — Capture typographic grid from body pose
 * Maps body keypoints to guide line positions with UPM normalization.
 *
 * Keypoint mapping:
 *   left_wrist       → ascender
 *   right_wrist      → cap height
 *   shoulders (avg)  → x-height
 *   knees (avg)      → baseline
 *   ankles (avg)     → descender
 *
 * The full body span (ascender to descender) maps to UPM.
 * Descender is forced to UPM - ascender, guaranteeing compliance.
 */

import { UPM, guideState } from './guides.js';
import { showToast } from './toast.js';

let _active = false;
let _captureBtn = null;
let _cancelBtn = null;
let _tabButtons = null;
let _markDirty = null;
let _syncSliders = null;
let _latestPreview = null;

const GUIDE_COLORS = {
    ascender:  '#E53935',
    capHeight: '#FB8C00',
    xHeight:   '#43A047',
    baseline:  '#1446FF',
    descender: '#8E24AA',
};

const GUIDE_LABELS = {
    ascender:  'Ascender ← L hand',
    capHeight: 'Cap ← R hand',
    xHeight:   'x-Height ← Shoulders',
    baseline:  'Baseline ← Knees',
    descender: 'Descender ← Feet',
};

export function isGridCaptureActive() { return _active; }

/**
 * Initialise grid capture. Call once from bindControls.
 */
export function initGridCapture({ captureBtn, cancelBtn, tabButtons, markDirty, syncSliders }) {
    _captureBtn = captureBtn;
    _cancelBtn = cancelBtn;
    _tabButtons = tabButtons;
    _markDirty = markDirty;
    _syncSliders = syncSliders;

    captureBtn.addEventListener('click', () => {
        if (_active) confirmCapture();
        else         startCapture();
    });

    cancelBtn.addEventListener('click', () => cancelCapture());

    document.addEventListener('keydown', (e) => {
        if (_active && e.key === 'Escape') cancelCapture();
    });
}

function startCapture() {
    _active = true;
    _latestPreview = null;
    _captureBtn.textContent = 'Confirm';
    _captureBtn.classList.add('btn--pulsing');
    if (_cancelBtn) _cancelBtn.style.display = '';
    if (_tabButtons) {
        _tabButtons.forEach(btn => {
            btn.disabled = true;
            btn.classList.add('sidebar-tab--disabled');
        });
    }
    _markDirty?.();
}

function cancelCapture() {
    _active = false;
    _latestPreview = null;
    _captureBtn.textContent = 'Capture Grid from Pose';
    _captureBtn.classList.remove('btn--pulsing');
    if (_cancelBtn) _cancelBtn.style.display = 'none';
    if (_tabButtons) {
        _tabButtons.forEach(btn => {
            btn.disabled = false;
            btn.classList.remove('sidebar-tab--disabled');
        });
    }
    _markDirty?.();
}

function confirmCapture() {
    if (!_latestPreview) {
        showToast('No pose detected — stand in frame');
        return;
    }

    const { ascY, capY, xhY, blY, descY } = _latestPreview;

    // Total range from ascender (topmost) to descender (bottommost)
    const totalRange = descY - ascY;
    if (totalRange <= 0) {
        showToast('Invalid pose — raise hands above feet');
        cancelCapture();
        return;
    }

    // Baseline position as % of canvas height
    guideState.baseline = Math.round(Math.max(0, Math.min(100, blY * 100)));

    // Ascender: font units above baseline, proportional to UPM
    const ascUnits = Math.round(((blY - ascY) / totalRange) * UPM);
    guideState.ascender = Math.max(0, Math.min(UPM, ascUnits));

    // Descender forced: UPM - ascender (guarantees sum = UPM)
    guideState.descender = UPM - guideState.ascender;

    // Cap height
    if (capY != null) {
        const capUnits = Math.round(((blY - capY) / totalRange) * UPM);
        guideState.capHeight = Math.max(0, Math.min(guideState.ascender, capUnits));
    }

    // x-Height
    if (xhY != null) {
        const xhUnits = Math.round(((blY - xhY) / totalRange) * UPM);
        guideState.xHeight = Math.max(0, Math.min(guideState.capHeight, xhUnits));
    }

    _syncSliders?.();
    cancelCapture();
    showToast('Grid captured from pose');
}

/**
 * Update the grid capture preview from the current pose.
 * Call every frame when grid capture is active.
 * @param {Array} scaledPose — keypoints with {name, x, y, confidence} in canvas pixels
 * @param {number} canvasH — canvas height in pixels
 * @returns {object|null} — preview Y fractions (0–1), or null if insufficient keypoints
 */
export function updateGridCapturePreview(scaledPose, canvasH) {
    if (!_active || !scaledPose || canvasH <= 0) return null;

    const getYFrac = (name) => {
        const kp = scaledPose.find(k => k.name === name);
        return (kp && kp.confidence >= 0.3) ? kp.y / canvasH : null;
    };

    const avgYFrac = (names) => {
        const vals = names.map(n => getYFrac(n)).filter(v => v !== null);
        return vals.length > 0 ? vals.reduce((a, b) => a + b) / vals.length : null;
    };

    const ascY  = getYFrac('left_wrist');
    const capY  = getYFrac('right_wrist');
    const xhY   = avgYFrac(['left_shoulder', 'right_shoulder']);
    const blY   = avgYFrac(['left_knee', 'right_knee']);
    const descY = avgYFrac(['left_ankle', 'right_ankle']);

    // Require at minimum: ascender, baseline, descender
    if (ascY == null || blY == null || descY == null) return null;

    _latestPreview = { ascY, capY, xhY, blY, descY };
    return _latestPreview;
}

/**
 * Draw the grid capture preview lines on the guides canvas.
 * Uses dashed lines with labels showing the body-part mapping.
 */
export function drawGridCapturePreview(ctx, preview, w, h) {
    if (!preview) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;

    const entries = [
        { key: 'ascender',  y: preview.ascY },
        { key: 'capHeight', y: preview.capY },
        { key: 'xHeight',   y: preview.xhY },
        { key: 'baseline',  y: preview.blY },
        { key: 'descender', y: preview.descY },
    ];

    for (const { key, y } of entries) {
        if (y == null) continue;
        const py = y * h;
        ctx.strokeStyle = GUIDE_COLORS[key];
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
        ctx.stroke();

        ctx.fillStyle = GUIDE_COLORS[key];
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(GUIDE_LABELS[key], 8, py - 6);
    }

    ctx.setLineDash([]);
    ctx.restore();
}
