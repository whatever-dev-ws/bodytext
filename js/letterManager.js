/**
 * letterManager.js — Letter save / load / switch
 * Manages the current letter state and provides save/load/switch operations.
 * Queries its own DOM elements internally — keeps app.js focused on orchestration.
 */

import { updateAlphabetGrid } from './alphabetGrid.js';

/* ── DOM refs (queried once on import) ────────────────────────────────── */

const letterInput       = document.getElementById('letter-input');
const letterStatus      = document.getElementById('letter-status');
const refLetterSelect   = document.getElementById('ref-letter-select');
const alphabetGridEl    = document.getElementById('alphabet-grid');
const bearingLeftSlider  = document.getElementById('guide-bearing-left-slider');
const bearingLeftValueEl = document.getElementById('guide-bearing-left-value');
const bearingRightSlider  = document.getElementById('guide-bearing-right-slider');
const bearingRightValueEl = document.getElementById('guide-bearing-right-value');

/* ── State ────────────────────────────────────────────────────────────── */

let currentLetter = 'A';

/* ── Dependencies (set via init) ──────────────────────────────────────── */

let shapeEditor    = null;
let bindingManager = null;
let letterStore    = null;
let guideState     = null;

/** Getter for the latest deformed points — set by the render loop in app.js. */
let _getDeformed   = () => null;

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
}

export function getCurrentLetter() { return currentLetter; }

export function setGetDeformed(fn) { _getDeformed = fn; }

/** Save the current letter to the store. */
export function saveCurrentLetter() {
    const deformed = _getDeformed();
    letterStore.saveLetter(currentLetter, {
        shapes:       shapeEditor.getShapes(),
        bindings:     bindingManager.getBindings(),
        joinFlags:    shapeEditor.getJoinFlags(),
        bearingLeft:  guideState.bearingLeft,
        bearingRight: guideState.bearingRight,
        deformedSnapshot: deformed
            ? JSON.parse(JSON.stringify(deformed))
            : null,
    });
    letterStatus.textContent = `'${currentLetter}' saved`;
    updateAlphabetGrid(alphabetGridEl, letterStore, currentLetter);
    updateRefLetterSelect();
}

/** Load the current letter from the store into the editor. */
export function loadCurrentLetter() {
    const data = letterStore.getLetter(currentLetter);
    if (data) {
        shapeEditor.loadShapes(data.shapes);
        shapeEditor.loadJoinFlags(data.joinFlags);
        bindingManager.loadBindings(data.bindings);
        shapeEditor.setStrokeWidth(shapeEditor.strokeWidth);
        shapeEditor.setLineCap(shapeEditor.lineCap);
        shapeEditor.setLineJoin(shapeEditor.lineJoin);
        shapeEditor.setTangencyStrength(shapeEditor.tangencyStrength);
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
    saveCurrentLetter();
    currentLetter = char;
    letterInput.value = currentLetter;
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
