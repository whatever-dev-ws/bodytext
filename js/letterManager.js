/**
 * letterManager.js — Letter save / load / switch
 * Manages the current letter state and provides save/load/switch operations.
 * Queries its own DOM elements internally — keeps app.js focused on orchestration.
 */

import { updateAlphabetGrid } from './alphabetGrid.js';
import { showToast } from './toast.js';
import { SKELETON, MIN_CONFIDENCE } from './renderer.js';
import { computeSplineSegments, DEFAULT_TANGENCY, buildJoinChains } from './shapes.js';
import { resolvePoints } from './viewportRenderer.js';

/* ── DOM refs (queried once on import) ────────────────────────────────── */

const letterInput       = document.getElementById('letter-input');
const letterStatus      = document.getElementById('letter-status');
const refLetterSelect   = document.getElementById('ref-letter-select');
const alphabetGridEl    = document.getElementById('alphabet-grid');
const letterHud         = document.getElementById('viewport-letter-hud');
const bearingLeftSlider  = document.getElementById('guide-bearing-left-slider');
const bearingLeftValueEl = document.getElementById('guide-bearing-left-value');
const bearingRightSlider  = document.getElementById('guide-bearing-right-slider');
const bearingRightValueEl = document.getElementById('guide-bearing-right-value');
const strokeSlider      = document.getElementById('stroke-slider');
const strokeValueEl     = document.getElementById('stroke-value');
const tangencySlider    = document.getElementById('tangency-slider');
const tangencyValueEl   = document.getElementById('tangency-value');
const capBtns           = document.querySelectorAll('.cap-btn');
const joinBtns          = document.querySelectorAll('.join-btn');

/* ── State ────────────────────────────────────────────────────────────── */

let currentLetter = 'A';

/* ── Dependencies (set via init) ──────────────────────────────────────── */

let shapeEditor    = null;
let bindingManager = null;
let letterStore    = null;
let guideState     = null;

/** Getter for the latest deformed points — set by the render loop in app.js. */
let _getDeformed   = () => null;
/** Reset deformed points when switching letters (avoids stale cross-letter data). */
let _resetDeformed = () => {};

/** Image capture callbacks — set via initLetterManager. */
let _captureWebcam   = null;
let _getSkeletonData = null;
let _getState        = null;

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Initialise the letter manager with its dependencies.
 * Call once after subsystems are created.
 */
export function initLetterManager(deps) {
    shapeEditor    = deps.shapeEditor;
    bindingManager = deps.bindingManager;
    letterStore    = deps.letterStore;
    guideState     = deps.guideState;
    _getDeformed   = deps.getDeformed ?? (() => null);
    _resetDeformed = deps.resetDeformed ?? (() => {});
    _captureWebcam   = deps.captureWebcam ?? null;
    _getSkeletonData = deps.getSkeletonData ?? null;
    _getState        = deps.getState ?? (() => ({}));
}

export function getCurrentLetter() { return currentLetter; }

export function setGetDeformed(fn) { _getDeformed = fn; }

/* ── SVG generation helpers ──────────────────────────────────────────── */

/** Convert a shape segment to SVG path data commands. */
function shapeToPathData(pts, shape, isFirst) {
    let d = '';
    if (isFirst) d += `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;

    if (shape.type === 'arc' && pts.length >= 2) {
        if (pts.length === 2 && !shape.closed) {
            d += `L${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
        } else {
            const segs = computeSplineSegments(pts, shape.tangency ?? DEFAULT_TANGENCY, shape.closed);
            for (const s of segs) {
                d += `C${s.cp1x.toFixed(1)} ${s.cp1y.toFixed(1)} ${s.cp2x.toFixed(1)} ${s.cp2y.toFixed(1)} ${s.ex.toFixed(1)} ${s.ey.toFixed(1)}`;
            }
        }
    } else {
        for (let i = 1; i < pts.length; i++) {
            d += `L${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
        }
    }

    if (shape.closed) d += 'Z';
    return d;
}

/** Build a full SVG string with glyph, skeleton bones, and joint nodes. */
function generateSkeletonSVG({ poses, shapes, deformed, joinFlags, getBinding, width, height }) {
    const lines = [];
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

    // Layer 1 (bottom): Glyph — black
    lines.push('  <g id="glyph">');
    const { chains, chainedIds } = buildJoinChains(shapes, joinFlags, getBinding);

    for (const chain of chains) {
        const firstShape = shapes.find(s => s.id === chain[0].shapeId);
        if (!firstShape) continue;
        let d = '';
        for (let ci = 0; ci < chain.length; ci++) {
            const { shapeId, reversed } = chain[ci];
            const shape = shapes.find(s => s.id === shapeId);
            if (!shape) continue;
            let pts = resolvePoints(shape, width, height, deformed);
            if (reversed) pts = [...pts].reverse();
            d += shapeToPathData(pts, shape, ci === 0);
        }
        lines.push(`    <path d="${d}" stroke="#000000" fill="none" stroke-width="${firstShape.strokeWidth}" stroke-linecap="${firstShape.lineCap || 'round'}" stroke-linejoin="${firstShape.lineJoin || 'round'}"/>`);
    }

    for (const shape of shapes) {
        if (chainedIds.has(shape.id)) continue;
        const pts = resolvePoints(shape, width, height, deformed);
        if (shape.type === 'dot' && pts.length >= 1) {
            lines.push(`    <circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="${(shape.strokeWidth / 2).toFixed(1)}" fill="#000000"/>`);
        } else if (pts.length >= 2) {
            const d = shapeToPathData(pts, shape, true);
            lines.push(`    <path d="${d}" stroke="#000000" fill="none" stroke-width="${shape.strokeWidth}" stroke-linecap="${shape.lineCap || 'round'}" stroke-linejoin="${shape.lineJoin || 'round'}"/>`);
        }
    }
    lines.push('  </g>');

    // Layer 2 (middle): Skeleton bones — yellow
    lines.push('  <g id="skeleton" stroke="#FFFF00" stroke-width="3" stroke-linecap="round" fill="none">');
    for (const pose of poses) {
        if (!pose) continue;
        const kp = {};
        for (const p of pose) kp[p.name] = p;
        for (const [a, b] of SKELETON) {
            if (!kp[a] || !kp[b]) continue;
            if (kp[a].confidence < MIN_CONFIDENCE || kp[b].confidence < MIN_CONFIDENCE) continue;
            lines.push(`    <line x1="${kp[a].x.toFixed(1)}" y1="${kp[a].y.toFixed(1)}" x2="${kp[b].x.toFixed(1)}" y2="${kp[b].y.toFixed(1)}"/>`);
        }
    }
    lines.push('  </g>');

    // Layer 3 (top): Nodes — blue
    lines.push('  <g id="nodes" fill="#0000FF">');
    for (const pose of poses) {
        if (!pose) continue;
        for (const p of pose) {
            if (p.confidence < MIN_CONFIDENCE) continue;
            lines.push(`    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"/>`);
        }
    }
    lines.push('  </g>');

    lines.push('</svg>');
    return lines.join('\n');
}

/** Download webcam PNG and skeleton SVG for the given letter. */
function captureImages(letter) {
    if (_captureWebcam) {
        const canvas = _captureWebcam();
        if (canvas) {
            canvas.toBlob((blob) => {
                if (!blob) return;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${letter}_webcam.png`;
                a.click();
                URL.revokeObjectURL(a.href);
            }, 'image/png');
        }
    }

    if (_getSkeletonData) {
        const data = _getSkeletonData();
        if (data) {
            const svg = generateSkeletonSVG(data);
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${letter}_skeleton.svg`;
            a.click();
            URL.revokeObjectURL(a.href);
        }
    }
}

/**
 * Save the current letter to the store.
 * @param {object} [opts]
 * @param {boolean} [opts.preserveSnapshot=false] — if true and a deformedSnapshot
 *   already exists in the store, keep it instead of overwriting with the live state.
 *   Used by auto-save (switchToLetter) so manual saves aren't silently overwritten.
 */
export function saveCurrentLetter({ preserveSnapshot = false } = {}) {
    const deformed = _getDeformed();
    const existing = preserveSnapshot ? letterStore.getLetter(currentLetter) : null;
    const snapshot = (preserveSnapshot && existing?.deformedSnapshot)
        ? existing.deformedSnapshot
        : (deformed ? JSON.parse(JSON.stringify(deformed)) : null);

    letterStore.saveLetter(currentLetter, {
        shapes:       shapeEditor.getShapes(),
        bindings:     bindingManager.getBindings(),
        joinFlags:    shapeEditor.getJoinFlags(),
        strokeWidth:      shapeEditor.strokeWidth,
        lineCap:          shapeEditor.lineCap,
        lineJoin:         shapeEditor.lineJoin,
        tangencyStrength: shapeEditor.tangencyStrength,
        bearingLeft:  guideState.bearingLeft,
        bearingRight: guideState.bearingRight,
        deformedSnapshot: snapshot,
    });
    if (preserveSnapshot) {
        if (shapeEditor.shapes.length > 0) {
            showToast(`${currentLetter} auto-saved`);
        }
    } else {
        showToast(`${currentLetter} captured`);
    }
    letterStatus.textContent = `'${currentLetter}' saved`;
    updateAlphabetGrid(alphabetGridEl, letterStore, currentLetter);
    updateRefLetterSelect();

    // Photo capture (only on manual Capture, not auto-save on switch)
    if (!preserveSnapshot && _getState().capturePhotos) {
        captureImages(currentLetter);
    }
}

/** Load the current letter from the store into the editor. */
export function loadCurrentLetter() {
    const data = letterStore.getLetter(currentLetter);
    if (data) {
        shapeEditor.loadShapes(data.shapes);
        shapeEditor.loadJoinFlags(data.joinFlags);
        bindingManager.loadBindings(data.bindings);
        shapeEditor.setStrokeWidth(data.strokeWidth ?? shapeEditor.strokeWidth);
        shapeEditor.setLineCap(data.lineCap ?? shapeEditor.lineCap);
        shapeEditor.setLineJoin(data.lineJoin ?? shapeEditor.lineJoin);
        shapeEditor.setTangencyStrength(data.tangencyStrength ?? shapeEditor.tangencyStrength);
        syncStrokeUI();
        syncSideBearings(data.bearingLeft ?? 10, data.bearingRight ?? 10);
        letterStatus.textContent = `'${currentLetter}' loaded`;
    } else {
        shapeEditor.loadShapes([]);
        shapeEditor.loadJoinFlags([]);
        bindingManager.clear();
        syncSideBearings(10, 10);
        letterStatus.textContent = `'${currentLetter}' — empty`;
    }
}

/** Copy shapes + bindings from another stored letter. */
export function copyFromLetter(refChar) {
    const data = letterStore.getLetter(refChar);
    if (!data) return;
    shapeEditor.loadShapes(data.shapes);
    shapeEditor.loadJoinFlags(data.joinFlags);
    bindingManager.loadBindings(data.bindings);
    shapeEditor.setStrokeWidth(shapeEditor.strokeWidth);
    shapeEditor.setLineCap(shapeEditor.lineCap);
    shapeEditor.setLineJoin(shapeEditor.lineJoin);
    shapeEditor.setTangencyStrength(shapeEditor.tangencyStrength);
    letterStatus.textContent = `Copied from '${refChar}'`;
}

/** Switch to a different letter (auto-saves the current one first). */
export function switchToLetter(char) {
    if (char === currentLetter) return;
    _resetDeformed();
    currentLetter = char;
    letterInput.value = currentLetter;
    if (letterHud) letterHud.textContent = currentLetter;
    loadCurrentLetter();
    updateAlphabetGrid(alphabetGridEl, letterStore, currentLetter);
    updateRefLetterSelect();
}

/** Rebuild the reference-letter dropdown from stored letters. */
export function updateRefLetterSelect() {
    const stored = letterStore.getStoredChars();
    const prev = refLetterSelect.value;
    refLetterSelect.innerHTML = '<option value="">None</option>';
    for (const char of stored) {
        if (char === currentLetter) continue;
        const opt = document.createElement('option');
        opt.value = char;
        opt.textContent = char;
        refLetterSelect.appendChild(opt);
    }
    if (stored.includes(prev) && prev !== currentLetter) {
        refLetterSelect.value = prev;
    }
}

/** Sync stroke/cap/join/tangency UI controls to match the editor state. */
function syncStrokeUI() {
    strokeSlider.value  = shapeEditor.strokeWidth;
    strokeValueEl.value = shapeEditor.strokeWidth;
    tangencySlider.value  = Math.round(shapeEditor.tangencyStrength * 100);
    tangencyValueEl.value = shapeEditor.tangencyStrength.toFixed(2);
    capBtns.forEach(b => b.classList.toggle('active', b.dataset.cap === shapeEditor.lineCap));
    joinBtns.forEach(b => b.classList.toggle('active', b.dataset.join === shapeEditor.lineJoin));
}

/** Update guideState side bearings and sync their sliders. */
export function syncSideBearings(left, right) {
    guideState.bearingLeft = left;
    guideState.bearingRight = right;
    bearingLeftSlider.value = left;
    bearingLeftValueEl.value = left;
    bearingRightSlider.value = right;
    bearingRightValueEl.value = right;
}

/** Set status text (for external callers). */
export function setStatus(text) {
    letterStatus.textContent = text;
}
