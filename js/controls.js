/**
 * controls.js — UI event binding
 * Wires all sidebar controls, viewport buttons, and keyboard shortcuts.
 * Queries its own DOM elements — app.js only needs to call bindControls() once.
 */

import { SHAPE_TYPES } from './shapes.js';
import { UPM, guideState } from './guides.js';
import { exportOTF } from './fontExport.js';
import { exportUFO } from './ufoExport.js';
import { exportSVGs } from './svgExport.js';
import { initAudioSave, toggleAudioSave, setSensitivity } from './audioSave.js';
import {
    getCurrentLetter, saveCurrentLetter, loadCurrentLetter, switchToLetter,
    copyFromLetter, updateRefLetterSelect,
} from './letterManager.js';
import { buildAlphabetGrid, updateAlphabetGrid } from './alphabetGrid.js';
import { initGridCapture } from './gridCapture.js';

/* ── Utilities ────────────────────────────────────────────────────────── */

/**
 * Two-way bind a range slider and a number input.
 * Slider value is always an integer; the number input may show a
 * transformed value (e.g. slider 0–100 <-> input 0.00–1.00).
 */
export function linkSlider(slider, input, { onChange, toDisplay, fromDisplay }) {
    const _toDisplay   = toDisplay   || ((v) => v);
    const _fromDisplay = fromDisplay || ((v) => v);

    slider.addEventListener('input', () => {
        const raw = Number(slider.value);
        input.value = _toDisplay(raw);
        onChange(raw);
    });

    input.addEventListener('change', () => {
        const sliderVal = Math.round(
            Math.max(Number(slider.min), Math.min(Number(slider.max), _fromDisplay(Number(input.value))))
        );
        slider.value = sliderVal;
        input.value  = _toDisplay(sliderVal);
        onChange(sliderVal);
    });
}

/* ── Guide constraint helpers ─────────────────────────────────────────── */

const guideUpmStatusEl       = document.getElementById('guide-upm-status');
const guideAscenderSlider    = document.getElementById('guide-ascender-slider');
const guideAscenderValueEl   = document.getElementById('guide-ascender-value');
const guideCapSlider         = document.getElementById('guide-cap-slider');
const guideCapValueEl        = document.getElementById('guide-cap-value');
const guideXHeightSlider     = document.getElementById('guide-xheight-slider');
const guideXHeightValueEl    = document.getElementById('guide-xheight-value');
const guideDescenderSlider   = document.getElementById('guide-descender-slider');
const guideDescenderValueEl  = document.getElementById('guide-descender-value');

function updateUpmStatus() {
    const total = guideState.ascender + guideState.descender;
    guideUpmStatusEl.textContent = `${guideState.ascender} + ${guideState.descender} = ${total} / ${UPM}`;
    guideUpmStatusEl.style.color = total > UPM ? '#E53935' : '';
}

function enforceGuideConstraints() {
    if (guideState.ascender + guideState.descender > UPM) {
        guideState.descender = UPM - guideState.ascender;
        if (guideState.descender < 0) {
            guideState.descender = 0;
            guideState.ascender = UPM;
        }
        guideDescenderSlider.value = guideState.descender;
        guideDescenderValueEl.value = guideState.descender;
        guideAscenderSlider.value = guideState.ascender;
        guideAscenderValueEl.value = guideState.ascender;
    }
    if (guideState.capHeight > guideState.ascender) {
        guideState.capHeight = guideState.ascender;
        guideCapSlider.value = guideState.capHeight;
        guideCapValueEl.value = guideState.capHeight;
    }
    if (guideState.xHeight > guideState.capHeight) {
        guideState.xHeight = guideState.capHeight;
        guideXHeightSlider.value = guideState.xHeight;
        guideXHeightValueEl.value = guideState.xHeight;
    }
    updateUpmStatus();
}

/* ── Main binding ─────────────────────────────────────────────────────── */

/**
 * Wire all UI controls.
 *
 * @param {object} deps
 * @param {object} deps.state — mutable state bag (activeTab, showVideo, etc.)
 * @param {ShapeEditor} deps.shapeEditor
 * @param {BindingManager} deps.bindingManager
 * @param {LetterStore} deps.letterStore
 * @param {Function} deps.getStaticSkeletons — returns current static skeletons array
 * @param {Function} deps.onDualPersonToggle — called when dual-person mode changes
 * @param {Function} deps.markDirty — signal that a redraw is needed
 * @param {Function} deps.syncVideoCSS — update video element CSS from state
 */
export function bindControls({ state, shapeEditor, bindingManager, letterStore, getStaticSkeletons, onDualPersonToggle, markDirty, syncVideoCSS }) {
    /* ── DOM refs ──────────────────────────────────────────────────────── */

    const tabBtns      = document.querySelectorAll('.sidebar-tab');
    const tabPanels    = document.querySelectorAll('.sidebar-panel');

    const btnPolyline  = document.getElementById('btn-tool-polyline');
    const btnArc       = document.getElementById('btn-tool-arc');
    const btnDot       = document.getElementById('btn-tool-dot');
    const strokeSlider   = document.getElementById('stroke-slider');
    const strokeValueEl  = document.getElementById('stroke-value');
    const tangencySlider  = document.getElementById('tangency-slider');
    const tangencyValueEl = document.getElementById('tangency-value');

    const capBtns  = document.querySelectorAll('.cap-btn');
    const joinBtns = document.querySelectorAll('.join-btn');

    const btnClearBindings  = document.getElementById('btn-clear-bindings');
    const btnMirrorBindings = document.getElementById('btn-mirror-bindings');

    const letterInput   = document.getElementById('letter-input');
    const btnSaveLetter = document.getElementById('btn-save-letter');
    const btnLoadLetter = document.getElementById('btn-load-letter');
    const letterStatus  = document.getElementById('letter-status');

    const refLetterSelect = document.getElementById('ref-letter-select');
    const btnCopyRef      = document.getElementById('btn-copy-ref');

    const btnExportJSON  = document.getElementById('btn-export-json');
    const btnImportJSON  = document.getElementById('btn-import-json');
    const fileImportJSON = document.getElementById('file-import-json');
    const btnExportOTF   = document.getElementById('btn-export-otf');
    const btnExportUFO   = document.getElementById('btn-export-ufo');
    const btnExportSVGs  = document.getElementById('btn-export-svgs');

    const btnDualPerson     = document.getElementById('btn-dual-person');
    const confidenceSlider  = document.getElementById('confidence-slider');
    const confidenceValueEl = document.getElementById('confidence-value');
    const smoothingSlider   = document.getElementById('smoothing-slider');
    const smoothingValueEl  = document.getElementById('smoothing-value');
    const opacitySlider     = document.getElementById('opacity-slider');
    const opacityValueEl    = document.getElementById('opacity-value');

    const btnMirror   = document.getElementById('btn-mirror');
    const btnVideo    = document.getElementById('btn-toggle-video');
    const btnSkeleton = document.getElementById('btn-toggle-skeleton');
    const btnFillFit  = document.getElementById('btn-fill-fit');
    const btnGuidesBtn = document.getElementById('btn-guides');

    const alphabetGridEl = document.getElementById('alphabet-grid');
    const btnGridCapture  = document.getElementById('btn-grid-capture');
    const btnGridCancel   = document.getElementById('btn-grid-cancel');
    const btnPhotoCapture = document.getElementById('btn-photo-capture');

    const guideBaselineSlider     = document.getElementById('guide-baseline-slider');
    const guideBaselineValueEl    = document.getElementById('guide-baseline-value');
    const guideBearingLeftSlider  = document.getElementById('guide-bearing-left-slider');
    const guideBearingLeftValueEl = document.getElementById('guide-bearing-left-value');
    const guideBearingRightSlider  = document.getElementById('guide-bearing-right-slider');
    const guideBearingRightValueEl = document.getElementById('guide-bearing-right-value');

    const audioSensitivitySlider  = document.getElementById('audio-sensitivity-slider');
    const audioSensitivityValueEl = document.getElementById('audio-sensitivity-value');

    /* ── Helpers ───────────────────────────────────────────────────────── */

    function setActiveTool(tool) {
        shapeEditor.setTool(tool);
        btnPolyline.classList.toggle('active', tool === SHAPE_TYPES.POLYLINE);
        btnArc.classList.toggle('active', tool === SHAPE_TYPES.ARC);
        btnDot.classList.toggle('active', tool === SHAPE_TYPES.DOT);
    }

    function updateDrawButtons() {
        // No-op — Extend/Confirm buttons removed; drawing is implicit.
    }

    /* ── Undo / Redo ──────────────────────────────────────────────────── */

    const UNDO_MAX = 50;
    const undoStack = [];
    const redoStack = [];

    function captureState() {
        return {
            shapes: shapeEditor.getShapes(),
            joinFlags: shapeEditor.getJoinFlags(),
            bindings: bindingManager.getBindings(),
        };
    }

    function restoreState(snapshot) {
        shapeEditor.loadShapes(snapshot.shapes);
        shapeEditor.loadJoinFlags(snapshot.joinFlags);
        bindingManager.loadBindings(snapshot.bindings);
    }

    function pushUndo() {
        undoStack.push(captureState());
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        redoStack.length = 0;
    }

    function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(captureState());
        restoreState(undoStack.pop());
        updateDrawButtons();
        markDirty();
    }

    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(captureState());
        restoreState(redoStack.pop());
        updateDrawButtons();
        markDirty();
    }

    /* ── Event binding ─────────────────────────────────────────────────── */

    // Sidebar tabs
    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            tabBtns.forEach((b) => b.classList.remove('active'));
            tabPanels.forEach((p) => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
            state.activeTab = btn.dataset.tab;
            syncVideoCSS();
            // Sync canvas buffers after layout reflow (skeleton editor canvas
            // may have been hidden and needs its dimensions recalculated)
            requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
            markDirty();
        });
    });

    // Shape tools — passive selectors (drawing starts on node click)
    btnPolyline.addEventListener('click', () => { setActiveTool(SHAPE_TYPES.POLYLINE); markDirty(); });
    btnArc.addEventListener('click', () => { setActiveTool(SHAPE_TYPES.ARC); markDirty(); });
    btnDot.addEventListener('click', () => { setActiveTool(SHAPE_TYPES.DOT); markDirty(); });

    // Stroke width
    linkSlider(strokeSlider, strokeValueEl, {
        onChange: (v) => { shapeEditor.setStrokeWidth(v); letterStore.setAllStrokeWidths(v); markDirty(); },
    });

    // Tangency (slider 0-100 <-> input 0.00-1.00)
    linkSlider(tangencySlider, tangencyValueEl, {
        onChange:     (v) => { shapeEditor.setTangencyStrength(v / 100); markDirty(); },
        toDisplay:   (v) => (v / 100).toFixed(2),
        fromDisplay: (v) => Math.round(v * 100),
    });

    // End cap buttons
    capBtns.forEach((btn) => btn.addEventListener('click', () => {
        capBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        shapeEditor.setLineCap(btn.dataset.cap);
        markDirty();
    }));

    // Line join buttons
    joinBtns.forEach((btn) => btn.addEventListener('click', () => {
        joinBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        shapeEditor.setLineJoin(btn.dataset.join);
        markDirty();
    }));

    // Clear all nodes
    btnClearBindings.addEventListener('click', () => {
        pushUndo();
        shapeEditor.clearAll();
        bindingManager.clear();
        letterStatus.textContent = 'Cleared all nodes';
        markDirty();
    });

    // Mirror bindings
    btnMirrorBindings.addEventListener('click', () => {
        pushUndo();
        bindingManager.mirrorBindings(shapeEditor.shapes, getStaticSkeletons());
        letterStatus.textContent = 'Bindings mirrored';
        markDirty();
    });

    // Drawing mode callbacks + mode indication
    const skelEditorContainer = document.getElementById('skeleton-editor-container');
    const editorModeLabel = document.getElementById('editor-mode-label');
    shapeEditor.onDrawingChange = () => {
        const isDrawing = shapeEditor.isDrawing();
        skelEditorContainer.classList.toggle('skeleton-editor--drawing', isDrawing);
        editorModeLabel.textContent = isDrawing ? 'DRAW' : 'EDIT';
        updateDrawButtons();
        markDirty();
    };
    shapeEditor.onSelectionChange = () => { updateDrawButtons(); markDirty(); };

    // Hook undo into shape editor mutations
    shapeEditor.onBeforeMutate = pushUndo;

    // Letter selector
    letterInput.addEventListener('input', () => {
        const val = letterInput.value;
        if (val.length > 0) {
            const newChar = val.charAt(val.length - 1);
            const current = getCurrentLetter();
            if (newChar !== current) {
                switchToLetter(newChar);
                markDirty();
            } else {
                letterInput.value = current;
            }
        }
    });
    btnSaveLetter.addEventListener('click', () => { saveCurrentLetter(); markDirty(); });
    btnLoadLetter.addEventListener('click', () => { loadCurrentLetter(); markDirty(); });

    // Reference letter — copy shapes + bindings from another letter
    btnCopyRef.addEventListener('click', () => {
        const refChar = refLetterSelect.value;
        if (refChar) { copyFromLetter(refChar); markDirty(); }
    });

    // Export / Import
    btnExportJSON.addEventListener('click', () => { saveCurrentLetter(); letterStore.exportJSON(guideState); });
    btnImportJSON.addEventListener('click', () => fileImportJSON.click());
    fileImportJSON.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            const { count, guides } = await letterStore.importJSON(e.target.files[0]);
            if (guides) {
                // Restore guide metrics and sync all sliders
                guideState.baseline     = guides.baseline     ?? guideState.baseline;
                guideState.ascender     = guides.ascender     ?? guideState.ascender;
                guideState.capHeight    = guides.capHeight    ?? guideState.capHeight;
                guideState.xHeight      = guides.xHeight      ?? guideState.xHeight;
                guideState.descender    = guides.descender    ?? guideState.descender;
                guideState.bearingLeft  = guides.bearingLeft  ?? guideState.bearingLeft;
                guideState.bearingRight = guides.bearingRight ?? guideState.bearingRight;
                guideBaselineSlider.value     = guideState.baseline;
                guideBaselineValueEl.value    = guideState.baseline;
                guideAscenderSlider.value     = guideState.ascender;
                guideAscenderValueEl.value    = guideState.ascender;
                guideCapSlider.value          = guideState.capHeight;
                guideCapValueEl.value         = guideState.capHeight;
                guideXHeightSlider.value      = guideState.xHeight;
                guideXHeightValueEl.value     = guideState.xHeight;
                guideDescenderSlider.value    = guideState.descender;
                guideDescenderValueEl.value   = guideState.descender;
                guideBearingLeftSlider.value  = guideState.bearingLeft;
                guideBearingLeftValueEl.value = guideState.bearingLeft;
                guideBearingRightSlider.value  = guideState.bearingRight;
                guideBearingRightValueEl.value = guideState.bearingRight;
                enforceGuideConstraints();
            }
            letterStatus.textContent = `Imported ${count} letters`;
            loadCurrentLetter();
            updateAlphabetGrid(alphabetGridEl, letterStore, getCurrentLetter());
            updateRefLetterSelect();
            markDirty();
            e.target.value = '';
        }
    });
    btnExportOTF.addEventListener('click', () => { saveCurrentLetter({ preserveSnapshot: true }); exportOTF(letterStore, guideState); });
    btnExportUFO.addEventListener('click', () => { saveCurrentLetter({ preserveSnapshot: true }); exportUFO(letterStore, guideState); });
    btnExportSVGs.addEventListener('click', () => {
        saveCurrentLetter({ preserveSnapshot: true });
        const count = exportSVGs(letterStore);
        letterStatus.textContent = count > 0 ? `Exporting ${count} SVGs\u2026` : 'No letters to export';
    });

    // Dual-person toggle (Pose tab)
    btnDualPerson.addEventListener('click', () => {
        state.dualPerson = !state.dualPerson;
        btnDualPerson.classList.toggle('active', state.dualPerson);
        onDualPersonToggle();
    });

    // Pose controls
    linkSlider(confidenceSlider, confidenceValueEl, {
        onChange:     (v) => { state.confidenceThreshold = v / 100; markDirty(); },
        toDisplay:   (v) => (v / 100).toFixed(2),
        fromDisplay: (v) => Math.round(v * 100),
    });
    linkSlider(smoothingSlider, smoothingValueEl, {
        onChange:     (v) => { state.smoothingFactor = v / 100; markDirty(); },
        toDisplay:   (v) => (v / 100).toFixed(1),
        fromDisplay: (v) => Math.round(v * 100),
    });
    linkSlider(opacitySlider, opacityValueEl, {
        onChange: (v) => { state.webcamOpacity = v / 100; syncVideoCSS(); },
    });

    // Keyboard: undo/redo
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
        }
    });

    // Keyboard letter switching
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length === 1 && e.key !== ' ') {
            switchToLetter(e.key);
            markDirty();
        }
    });

    // Guide controls
    linkSlider(guideBaselineSlider, guideBaselineValueEl, {
        onChange: (v) => { guideState.baseline = v; markDirty(); },
    });
    linkSlider(guideAscenderSlider, guideAscenderValueEl, {
        onChange: (v) => { guideState.ascender = v; enforceGuideConstraints(); markDirty(); },
    });
    linkSlider(guideCapSlider, guideCapValueEl, {
        onChange: (v) => { guideState.capHeight = v; enforceGuideConstraints(); markDirty(); },
    });
    linkSlider(guideXHeightSlider, guideXHeightValueEl, {
        onChange: (v) => { guideState.xHeight = v; enforceGuideConstraints(); markDirty(); },
    });
    linkSlider(guideDescenderSlider, guideDescenderValueEl, {
        onChange: (v) => { guideState.descender = v; enforceGuideConstraints(); markDirty(); },
    });
    linkSlider(guideBearingLeftSlider, guideBearingLeftValueEl, {
        onChange: (v) => { guideState.bearingLeft = v; markDirty(); },
    });
    linkSlider(guideBearingRightSlider, guideBearingRightValueEl, {
        onChange: (v) => { guideState.bearingRight = v; markDirty(); },
    });

    // Audio save sensitivity
    linkSlider(audioSensitivitySlider, audioSensitivityValueEl, {
        onChange: (v) => setSensitivity(v),
    });

    // Viewport controls
    btnMirror.addEventListener('click', () => {
        state.mirrorVideo = !state.mirrorVideo;
        btnMirror.classList.toggle('active', state.mirrorVideo);
        syncVideoCSS();
        markDirty();
    });
    btnVideo.addEventListener('click', () => {
        state.showVideo = !state.showVideo;
        btnVideo.classList.toggle('active', state.showVideo);
        syncVideoCSS();
    });
    btnSkeleton.addEventListener('click', () => {
        state.showSkeletonDots = !state.showSkeletonDots;
        btnSkeleton.classList.toggle('active', state.showSkeletonDots);
        markDirty();
    });
    btnFillFit.addEventListener('click', () => {
        state.fillMode = !state.fillMode;
        btnFillFit.classList.toggle('active', state.fillMode);
        syncVideoCSS();
        markDirty();
    });
    btnGuidesBtn.addEventListener('click', () => {
        state.showGuides = !state.showGuides;
        btnGuidesBtn.classList.toggle('active', state.showGuides);
        document.getElementById('canvas-guides').style.pointerEvents = state.showGuides ? 'auto' : 'none';
        markDirty();
    });

    // Audio save module
    initAudioSave({
        buttonEl:    document.getElementById('btn-audio-save'),
        controlsEl:  document.getElementById('audio-controls'),
        meterFillEl: document.getElementById('audio-meter-fill'),
        onSave() {
            saveCurrentLetter();
            updateAlphabetGrid(alphabetGridEl, letterStore, getCurrentLetter());
        },
    });
    document.getElementById('btn-audio-save').addEventListener('click', toggleAudioSave);

    // Grid capture from pose
    initGridCapture({
        captureBtn: btnGridCapture,
        cancelBtn: btnGridCancel,
        tabButtons: tabBtns,
        markDirty,
        syncSliders: () => {
            guideBaselineSlider.value = guideState.baseline;
            guideBaselineValueEl.value = guideState.baseline;
            guideAscenderSlider.value = guideState.ascender;
            guideAscenderValueEl.value = guideState.ascender;
            guideCapSlider.value = guideState.capHeight;
            guideCapValueEl.value = guideState.capHeight;
            guideXHeightSlider.value = guideState.xHeight;
            guideXHeightValueEl.value = guideState.xHeight;
            guideDescenderSlider.value = guideState.descender;
            guideDescenderValueEl.value = guideState.descender;
            updateUpmStatus();
        },
    });

    // Photo capture toggle
    btnPhotoCapture.addEventListener('click', () => {
        state.capturePhotos = !state.capturePhotos;
        btnPhotoCapture.classList.toggle('active', state.capturePhotos);
    });

    // Alphabet grid
    buildAlphabetGrid(alphabetGridEl, switchToLetter);
    updateAlphabetGrid(alphabetGridEl, letterStore, getCurrentLetter());
    updateRefLetterSelect();

    // Set initial tool
    setActiveTool(SHAPE_TYPES.POLYLINE);

    // Collapsible sections
    document.querySelectorAll('.collapsible-toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const section = toggle.closest('.collapsible-section');
            const isCollapsed = section.dataset.collapsed === 'true';
            section.dataset.collapsed = isCollapsed ? 'false' : 'true';
        });
    });

    // Sidebar resize handle
    const resizeHandle = document.getElementById('sidebar-resize-handle');
    let isResizing = false;
    let resizeRafId = null;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        e.preventDefault();
        const clientX = e.clientX;
        if (resizeRafId) return;
        resizeRafId = requestAnimationFrame(() => {
            const pct = Math.max(15, Math.min(50, (clientX / window.innerWidth) * 100));
            document.documentElement.style.setProperty('--sidebar-width', pct + '%');
            window.dispatchEvent(new Event('resize'));
            resizeRafId = null;
        });
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeRafId = null;
        }
    });
}
