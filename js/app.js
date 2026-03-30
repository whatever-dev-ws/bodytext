/**
 * app.js — Main orchestrator
 * Initialises subsystems, owns the render loop, delegates UI wiring
 * to controls.js and letter management to letterManager.js.
 */

import { PoseDetector } from './pose.js';
import { drawStickman, drawSkeletonLabel } from './renderer.js';
import { ShapeEditor } from './shapes.js';
import { BindingManager } from './bindings.js';
import { LetterStore } from './letterStore.js';
import { initCamera, computeCrop } from './camera.js';
import { guideState, drawGuides, initGuideDrag } from './guides.js';
import { drawShapesOnViewport, drawStoredLetterOnViewport } from './viewportRenderer.js';
import { initLetterManager, getCurrentLetter } from './letterManager.js';
import { bindControls } from './controls.js';
import { isGridCaptureActive, updateGridCapturePreview, drawGridCapturePreview } from './gridCapture.js';

/* ── DOM refs (viewport + skeleton editor only) ───────────────────────── */

const videoEl      = document.getElementById('video');
const skeletonEl   = document.getElementById('canvas-skeleton');
const letterEl     = document.getElementById('canvas-letter');
const guidesEl     = document.getElementById('canvas-guides');
const skelEditorEl = document.getElementById('canvas-skeleton-editor');
const statusEl     = document.getElementById('status');

/* ── Shared mutable state (read by render loop, written by controls) ── */

const state = {
    activeTab:           'setup',
    showVideo:           true,
    showSkeletonDots:    true,
    mirrorVideo:         true,
    fillMode:            true,
    showGuides:          false,
    dualPerson:          false,
    webcamOpacity:       0.5,
    confidenceThreshold: 0.3,
    smoothingFactor:     0.5,
    capturePhotos:       false,
    /** Expose current letter for modules that need it without importing letterManager. */
    getCurrentLetter,
};

/* ── Subsystem instances ──────────────────────────────────────────────── */

let detector       = null;
let skeletonCtx    = null;
let letterCtx      = null;
let guidesCtx      = null;
let skelEditorCtx  = null;

let shapeEditor    = null;
let bindingManager = null;
let letterStore    = null;

let crop = { sx: 0, sy: 0, srcW: 0, srcH: 0 };
let latestDeformedPoints = null;
let latestAssignedPoses = [null, null];
/** Per-slot temporal smoothing (keyed by identity, not raw detector index). */
let smoothedSlots = [null, null];
/** Tracked centroids for stable A/B assignment across frames. */
let prevSkeletonCentroids = [null, null];

/* ── Static skeletons (sidebar editor reference poses) ─────────────────── */

const SKELETON_NAMES  = ['A', 'B'];
const SKELETON_COLORS = ['#1446FF', '#E91E63'];

const BASE_SKELETON = [
    { name: 'nose',            x: 0.50, y: 0.08, confidence: 1 },
    { name: 'left_eye',        x: 0.48, y: 0.06, confidence: 1 },
    { name: 'right_eye',       x: 0.52, y: 0.06, confidence: 1 },
    { name: 'left_ear',        x: 0.45, y: 0.08, confidence: 1 },
    { name: 'right_ear',       x: 0.55, y: 0.08, confidence: 1 },
    { name: 'left_shoulder',   x: 0.38, y: 0.22, confidence: 1 },
    { name: 'right_shoulder',  x: 0.62, y: 0.22, confidence: 1 },
    { name: 'left_elbow',      x: 0.30, y: 0.38, confidence: 1 },
    { name: 'right_elbow',     x: 0.70, y: 0.38, confidence: 1 },
    { name: 'left_wrist',      x: 0.25, y: 0.52, confidence: 1 },
    { name: 'right_wrist',     x: 0.75, y: 0.52, confidence: 1 },
    { name: 'left_hip',        x: 0.42, y: 0.52, confidence: 1 },
    { name: 'right_hip',       x: 0.58, y: 0.52, confidence: 1 },
    { name: 'left_knee',       x: 0.40, y: 0.72, confidence: 1 },
    { name: 'right_knee',      x: 0.60, y: 0.72, confidence: 1 },
    { name: 'left_ankle',      x: 0.39, y: 0.90, confidence: 1 },
    { name: 'right_ankle',     x: 0.61, y: 0.90, confidence: 1 },
];

/** Generate a static skeleton shifted to a given center and x-scale. */
function makeStaticSkeleton(centerX, xScale) {
    return BASE_SKELETON.map((kp) => ({
        ...kp,
        x: centerX + (kp.x - 0.50) * xScale,
    }));
}

const STATIC_SKELETONS_DUAL = [
    makeStaticSkeleton(0.27, 0.70),  // A (left)
    makeStaticSkeleton(0.73, 0.70),  // B (right)
];

const STATIC_SKELETONS_SINGLE = [
    makeStaticSkeleton(0.50, 0.85),  // A (centered)
];

let STATIC_SKELETONS = STATIC_SKELETONS_SINGLE;

/** Switch sidebar reference skeletons when dual-person mode changes.
 *  Remaps all bound shape control points to the new keypoint positions
 *  so shapes follow the skeletons when the layout changes. */
function updateStaticSkeletons() {
    const newSkeletons = state.dualPerson ? STATIC_SKELETONS_DUAL : STATIC_SKELETONS_SINGLE;

    // Build lookup: skeletonIndex → keypointName → { x, y } for new layout
    const skeletonMaps = newSkeletons.map((kps) => {
        const map = {};
        for (const kp of kps) map[kp.name] = kp;
        return map;
    });

    // Move each bound shape point to the keypoint's new position
    const bindings = bindingManager.getBindings();
    for (const [key, value] of Object.entries(bindings)) {
        const [shapeIdStr, pointIdxStr] = key.split(':');
        const skIdx = Number(value.substring(0, value.indexOf(':')));
        const kpName = value.substring(value.indexOf(':') + 1);

        const newKp = skeletonMaps[skIdx]?.[kpName];
        if (!newKp) continue;  // skeleton B bindings in single mode — leave in place

        const shape = shapeEditor.shapes.find((s) => s.id === Number(shapeIdStr));
        const pt = shape?.points[Number(pointIdxStr)];
        if (pt) {
            pt.x = newKp.x;
            pt.y = newKp.y;
        }
    }

    STATIC_SKELETONS = newSkeletons;
    prevSkeletonCentroids = [null, null];
    smoothedSlots = [null, null];
    _renderDirty = true;
}

/* ── Video CSS control ─────────────────────────────────────────────────── */
// Video display is handled by the browser compositor (CSS), NOT by drawing
// to a canvas. This eliminates per-frame pixel copies entirely.

/** Apply current state to the <video> element's CSS. Called on state changes. */
function syncVideoCSS() {
    const visible = state.showVideo && state.activeTab !== 'alphabet' && state.activeTab !== 'export';
    videoEl.style.display    = visible ? 'block' : 'none';
    videoEl.style.opacity    = state.webcamOpacity;
    videoEl.style.objectFit  = state.fillMode ? 'cover' : 'contain';
    videoEl.style.transform  = state.mirrorVideo ? 'scaleX(-1)' : 'none';
}

/* ── Canvas sizing ─────────────────────────────────────────────────────── */

function syncCanvasBuffers() {
    for (const el of [skeletonEl, letterEl, guidesEl]) {
        el.width  = el.clientWidth;
        el.height = el.clientHeight;
    }
    skelEditorEl.width  = skelEditorEl.clientWidth;
    skelEditorEl.height = skelEditorEl.clientHeight;
    // Recompute crop for keypoint mapping after resize
    _cachedCrop = null;
}

/** Cached crop — only recomputed on resize or fillMode toggle. */
let _cachedCrop     = null;
let _cachedFillMode = null;

function getCrop(canvasW, canvasH) {
    const videoW = videoEl.videoWidth;
    const videoH = videoEl.videoHeight;
    if (!videoW || !videoH) return crop;
    if (_cachedCrop && _cachedFillMode === state.fillMode) return _cachedCrop;
    _cachedCrop     = computeCrop(canvasW, canvasH, videoW, videoH, state.fillMode);
    _cachedFillMode = state.fillMode;
    return _cachedCrop;
}

/* ── Dirty-flag rendering ─────────────────────────────────────────────── */
// Only redraw canvases when something actually changed.
// The detector's frameId tracks new pose data; _renderDirty tracks UI changes.

let _lastRenderedFrameId = -1;
/** Set to true by controls/state changes that require a redraw. */
let _renderDirty = true;

/** Mark render as dirty — called by controls when state changes. */
function markDirty() { _renderDirty = true; }

function setupCanvas() {
    syncCanvasBuffers();
    window.addEventListener('resize', () => { syncCanvasBuffers(); markDirty(); });
    skeletonCtx   = skeletonEl.getContext('2d');
    letterCtx     = letterEl.getContext('2d');
    guidesCtx     = guidesEl.getContext('2d');
    skelEditorCtx = skelEditorEl.getContext('2d');

    shapeEditor    = new ShapeEditor(skelEditorEl);
    bindingManager = new BindingManager();
    letterStore    = new LetterStore();

    // Guide lines can be dragged directly on the viewport
    initGuideDrag(guidesEl, state, markDirty);

    // Mouse interaction on the editor canvas must trigger redraws
    // so that hover highlights, drag visuals, and selections update.
    skelEditorEl.addEventListener('mousemove', markDirty);
    skelEditorEl.addEventListener('mousedown', markDirty);
    skelEditorEl.addEventListener('mouseup',   markDirty);

    // Auto-bind when shapes snap to skeleton keypoints
    shapeEditor.onSnap = (shapeId, pointIndex, keypointName, skeletonIndex) => {
        bindingManager.bind(shapeId, pointIndex, keypointName, skeletonIndex);
    };

    // Unbind when a placed point is deleted
    shapeEditor.onPointDeleted = (shapeId, pointIndex) => {
        bindingManager.unbind(shapeId, pointIndex);
    };

    // Re-bind when a placed point is dragged to a new node
    shapeEditor.onPointMoved = (shapeId, pointIndex, keypointName, skeletonIndex) => {
        bindingManager.unbind(shapeId, pointIndex);
        bindingManager.bind(shapeId, pointIndex, keypointName, skeletonIndex);
    };

    // Shift binding indices when a point is prepended
    shapeEditor.onPointPrepended = (shapeId, _insertedIndex) => {
        bindingManager.shiftPointIndices(shapeId, 0, 1);
    };
}

/* ── Render loop ───────────────────────────────────────────────────────── */

function render() {
    // Check if anything changed — skip work when idle
    const currentFrameId = detector ? detector.getFrameId() : -1;
    const hasNewPose = currentFrameId !== _lastRenderedFrameId;
    if (!hasNewPose && !_renderDirty) {
        requestAnimationFrame(render);
        return;
    }
    _lastRenderedFrameId = currentFrameId;
    _renderDirty = false;

    const gw = skeletonEl.width;
    const gh = skeletonEl.height;
    const lw = letterEl.width;
    const lh = letterEl.height;
    const guW = guidesEl.width;
    const guH = guidesEl.height;
    const ew = skelEditorEl.width;
    const eh = skelEditorEl.height;

    skeletonCtx.clearRect(0, 0, gw, gh);
    letterCtx.clearRect(0, 0, lw, lh);
    guidesCtx.clearRect(0, 0, guW, guH);
    skelEditorCtx.clearRect(0, 0, ew, eh);

    if (state.activeTab === 'alphabet') {
        // ── ALPHABET TAB: show stored letter preview with guides ──
        const data = letterStore.getLetter(getCurrentLetter());
        if (data?.shapes?.length) {
            drawStoredLetterOnViewport(letterCtx, lw, lh, data);
        }
        drawGuides(guidesCtx, guW, guH);
    } else {
        // ── GLYPH / POSE / GUIDES TABS: live camera + skeleton + deformed shapes ──
        // Video is rendered by the browser compositor via CSS (no drawImage needed).
        // We only need the crop values for mapping keypoints from video to canvas coords.
        crop = getCrop(gw, gh);

        // Layer 1: Skeleton overlay
        const assignedPoses = [null, null]; // [A, B]
        if (crop.srcW > 0 && crop.srcH > 0) {
            const rawPoses = detector.getPoses();

            // Scale all raw poses to canvas coords (no smoothing yet —
            // smoothing is applied per-slot AFTER identity assignment)
            const allScaled = rawPoses.map((keypoints) =>
                keypoints.map((kp) => ({
                    ...kp,
                    x: state.mirrorVideo
                        ? gw - ((kp.x - crop.sx) * (gw / crop.srcW))
                        : (kp.x - crop.sx) * (gw / crop.srcW),
                    y: (kp.y - crop.sy) * (gh / crop.srcH),
                }))
            );

            // Compute centroid for each detected pose
            const posesWithCentroid = allScaled.map((kps) => {
                const vis = kps.filter((kp) => kp.confidence >= 0.3);
                const cx = vis.length ? vis.reduce((s, kp) => s + kp.x, 0) / vis.length : Infinity;
                const cy = vis.length ? vis.reduce((s, kp) => s + kp.y, 0) / vis.length : Infinity;
                return { kps, cx, cy };
            });

            // Assign poses to A/B using centroid tracking (proximity to previous frame)
            const candidates = posesWithCentroid.filter((p) => p.cx !== Infinity);
            if (!state.dualPerson) {
                // Single-person mode: only assign slot A (pick closest to prev or first)
                if (candidates.length >= 1) {
                    let best = candidates[0];
                    if (prevSkeletonCentroids[0] && candidates.length > 1) {
                        best = candidates.reduce((a, b) =>
                            Math.hypot(a.cx - prevSkeletonCentroids[0].x, a.cy - prevSkeletonCentroids[0].y)
                            <= Math.hypot(b.cx - prevSkeletonCentroids[0].x, b.cy - prevSkeletonCentroids[0].y) ? a : b
                        );
                    }
                    assignedPoses[0] = best.kps;
                    prevSkeletonCentroids[0] = { x: best.cx, y: best.cy };
                    prevSkeletonCentroids[1] = null;
                }
            } else if (candidates.length === 1) {
                const p = candidates[0];
                if (prevSkeletonCentroids[0] && prevSkeletonCentroids[1]) {
                    const d0 = Math.hypot(p.cx - prevSkeletonCentroids[0].x, p.cy - prevSkeletonCentroids[0].y);
                    const d1 = Math.hypot(p.cx - prevSkeletonCentroids[1].x, p.cy - prevSkeletonCentroids[1].y);
                    const slot = d0 <= d1 ? 0 : 1;
                    assignedPoses[slot] = p.kps;
                    prevSkeletonCentroids[slot] = { x: p.cx, y: p.cy };
                } else {
                    assignedPoses[0] = p.kps;
                    prevSkeletonCentroids[0] = { x: p.cx, y: p.cy };
                }
            } else if (candidates.length >= 2) {
                const a = candidates[0];
                const b = candidates[1];
                if (prevSkeletonCentroids[0] && prevSkeletonCentroids[1]) {
                    const keepDist = Math.hypot(a.cx - prevSkeletonCentroids[0].x, a.cy - prevSkeletonCentroids[0].y)
                                   + Math.hypot(b.cx - prevSkeletonCentroids[1].x, b.cy - prevSkeletonCentroids[1].y);
                    const swapDist = Math.hypot(a.cx - prevSkeletonCentroids[1].x, a.cy - prevSkeletonCentroids[1].y)
                                   + Math.hypot(b.cx - prevSkeletonCentroids[0].x, b.cy - prevSkeletonCentroids[0].y);
                    if (swapDist < keepDist) {
                        assignedPoses[0] = b.kps; assignedPoses[1] = a.kps;
                        prevSkeletonCentroids[0] = { x: b.cx, y: b.cy };
                        prevSkeletonCentroids[1] = { x: a.cx, y: a.cy };
                    } else {
                        assignedPoses[0] = a.kps; assignedPoses[1] = b.kps;
                        prevSkeletonCentroids[0] = { x: a.cx, y: a.cy };
                        prevSkeletonCentroids[1] = { x: b.cx, y: b.cy };
                    }
                } else {
                    const sorted = [a, b].sort((x, y) => x.cx - y.cx);
                    assignedPoses[0] = sorted[0].kps; assignedPoses[1] = sorted[1].kps;
                    prevSkeletonCentroids[0] = { x: sorted[0].cx, y: sorted[0].cy };
                    prevSkeletonCentroids[1] = { x: sorted[1].cx, y: sorted[1].cy };
                }
            }

            // Build slot lookup from raw (pre-smoothing) assignments
            const rawSlotMap = new Map();
            for (let i = 0; i < 2; i++) {
                if (assignedPoses[i]) rawSlotMap.set(assignedPoses[i], i);
            }

            // Apply per-slot temporal smoothing (keyed by identity, not raw index)
            for (let slot = 0; slot < 2; slot++) {
                if (!assignedPoses[slot]) { smoothedSlots[slot] = null; continue; }
                if (smoothedSlots[slot] && state.smoothingFactor > 0) {
                    assignedPoses[slot] = assignedPoses[slot].map((kp, i) => {
                        const prev = smoothedSlots[slot][i];
                        if (!prev || prev.confidence < state.confidenceThreshold) return kp;
                        const t = 1 - state.smoothingFactor;
                        return {
                            ...kp,
                            x: prev.x + (kp.x - prev.x) * t,
                            y: prev.y + (kp.y - prev.y) * t,
                        };
                    });
                }
                smoothedSlots[slot] = assignedPoses[slot];
            }

            // Draw all skeletons with color-coded labels
            if (state.showSkeletonDots) {
                for (const p of posesWithCentroid) {
                    const slot = rawSlotMap.get(p.kps);
                    const drawKps = slot != null ? assignedPoses[slot] : p.kps;
                    const color = slot != null ? SKELETON_COLORS[slot] : '#999';
                    drawStickman(skeletonCtx, drawKps, {
                        drawBones: false,
                        jointRadius: 5,
                        jointColor: color,
                        drawHead: false,
                    });
                    if (slot != null) {
                        drawSkeletonLabel(skeletonCtx, drawKps, SKELETON_NAMES[slot], { color });
                    }
                }
            }
        }

        latestAssignedPoses = [assignedPoses[0], assignedPoses[1]];

        // Layer 2: Shapes on viewport (deformed by live poses)
        if (assignedPoses[0] || assignedPoses[1]) {
            latestDeformedPoints = bindingManager.applyBindings(assignedPoses, lw, lh);
        }
        const shapes    = shapeEditor.getShapes();
        const joinFlags = shapeEditor.getJoinFlags();
        const getBinding = (sid, pidx) => bindingManager.getBinding(sid, pidx);
        drawShapesOnViewport(letterCtx, lw, lh, latestDeformedPoints, shapes, joinFlags, getBinding);

        // Layer 3: Guides
        if (state.showGuides) {
            drawGuides(guidesCtx, guW, guH);
        }


        // Grid capture preview overlay
        if (isGridCaptureActive() && assignedPoses[0]) {
            const preview = updateGridCapturePreview(assignedPoses[0], gh);
            if (preview) {
                drawGridCapturePreview(guidesCtx, preview, guW, guH);
            }
        }
    }

    // Sidebar: skeleton editor
    const sidebarKeypoints = drawSidebarSkeleton(ew, eh);
    shapeEditor.setSnapTargets(sidebarKeypoints, ew, eh);
    shapeEditor.draw(null);

    requestAnimationFrame(render);
}

/**
 * Draw the static reference stickmen in the sidebar skeleton editor.
 * Renders Ficarra (left) and Picone (right) with color-coded labels.
 * Returns the combined pixel-scaled keypoints array (for snap targets).
 */
function drawSidebarSkeleton(ew, eh) {
    const allKeypoints = [];
    const skeletonCount = state.dualPerson ? STATIC_SKELETONS.length : 1;

    for (let si = 0; si < skeletonCount; si++) {
        const skeleton = STATIC_SKELETONS[si];
        const color = SKELETON_COLORS[si];

        const scaled = skeleton.map((kp) => ({
            ...kp,
            x: kp.x * ew,
            y: kp.y * eh,
            skeletonIndex: si,
        }));

        drawStickman(skelEditorCtx, scaled, {
            color: si === 0 ? '#bbb' : '#d4a0b0',
            boneWidth: 2,
            jointRadius: 3,
            drawHead: true,
        });

        skelEditorCtx.save();
        const ringColor = si === 0 ? 'rgba(20, 70, 255, 0.35)' : 'rgba(233, 30, 99, 0.35)';
        for (const kp of scaled) {
            skelEditorCtx.beginPath();
            skelEditorCtx.strokeStyle = ringColor;
            skelEditorCtx.lineWidth = 1.5;
            skelEditorCtx.arc(kp.x, kp.y, 8, 0, Math.PI * 2);
            skelEditorCtx.stroke();
        }
        skelEditorCtx.restore();

        drawSkeletonLabel(skelEditorCtx, scaled, SKELETON_NAMES[si], { color });

        allKeypoints.push(...scaled);
    }

    return allKeypoints;
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

async function init() {
    try {
        setupCanvas();

        // Initialise letter manager
        initLetterManager({
            shapeEditor,
            bindingManager,
            letterStore,
            guideState,
            getDeformed: () => latestDeformedPoints,
            resetDeformed: () => { latestDeformedPoints = null; },
            captureWebcam: () => {
                const w = skeletonEl.width;
                const h = skeletonEl.height;
                const c = getCrop(w, h);
                if (!c.srcW || !c.srcH) return null;
                const offscreen = document.createElement('canvas');
                offscreen.width = w;
                offscreen.height = h;
                const ctx = offscreen.getContext('2d');
                if (state.mirrorVideo) {
                    ctx.translate(w, 0);
                    ctx.scale(-1, 1);
                }
                ctx.drawImage(videoEl, c.sx, c.sy, c.srcW, c.srcH, 0, 0, w, h);
                return offscreen;
            },
            getSkeletonData: () => ({
                poses: latestAssignedPoses,
                shapes: shapeEditor.getShapes(),
                deformed: latestDeformedPoints,
                joinFlags: shapeEditor.getJoinFlags(),
                getBinding: (sid, pidx) => bindingManager.getBinding(sid, pidx),
                width: skeletonEl.width,
                height: skeletonEl.height,
            }),
            getState: () => state,
        });

        // Wire all UI controls
        bindControls({
            state,
            shapeEditor,
            bindingManager,
            letterStore,
            getStaticSkeletons: () => STATIC_SKELETONS,
            onDualPersonToggle: updateStaticSkeletons,
            markDirty,
            syncVideoCSS,
        });

        statusEl.textContent = 'Requesting camera\u2026';
        await initCamera(videoEl);
        syncVideoCSS();

        statusEl.textContent = 'Loading pose model\u2026';
        detector = new PoseDetector();
        await detector.init(videoEl);

        statusEl.textContent = `Ready (${detector.backend})`;

        requestAnimationFrame(render);
    } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        console.error(err);
    }
}

init();
