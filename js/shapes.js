/**
 * shapes.js — Vector shape editor
 * Supports three shape types: polyline, arc/bezier, and dot.
 * Points can ONLY be placed on skeleton nodes (snap targets).
 *
 * Two modes:
 *   EDIT (default) — hover shapes, click to select, drag points, right-click to delete
 *   DRAW           — entered via startNewShape(), click nodes to place points,
 *                     finish via finishActiveShape() / Esc / Enter / double-click
 *
 * Multiple shapes can share the same starting node because drawing only
 * happens in explicit draw mode — clicking a node in edit mode selects, not creates.
 */

let nextId = 1;

/** Default tangency strength for smooth curves. */
export const DEFAULT_TANGENCY = 0.5;

/** Shape types enum. */
export const SHAPE_TYPES = {
    POLYLINE: 'polyline',
    ARC:      'arc',
    DOT:      'dot',
};

function createShape(type, points, strokeWidth, lineCap, lineJoin, tangency) {
    return { id: nextId++, type, points, strokeWidth, lineCap, lineJoin, tangency, closed: false };
}

/**
 * Spline segment cache — content-addressed by point positions + tension.
 * Avoids recomputing Catmull-Rom control points every frame when points
 * haven't moved (e.g. static poses, no active editing).
 * @private
 */
const _splineCache = new Map();
const _SPLINE_CACHE_MAX = 128;

/**
 * Build a cache key from point positions + tension.
 * Rounds to 1 decimal place so sub-pixel jitter from temporal smoothing
 * doesn't cause continuous cache misses.
 * @private
 */
function _splineCacheKey(pts, tension) {
    let key = tension.toFixed(2);
    for (let i = 0; i < pts.length; i++) {
        key += '|' + pts[i].x.toFixed(1) + ',' + pts[i].y.toFixed(1);
    }
    return key;
}

/**
 * Compute cubic bezier control points for a Catmull-Rom-style spline (uncached).
 * @private
 */
function _computeSplineSegmentsCore(pts, tension) {
    const segs = [];
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
        const p0 = pts[Math.max(i - 1, 0)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(i + 2, n - 1)];

        const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
        const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
        const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
        const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

        segs.push({ cp1x, cp1y, cp2x, cp2y, ex: p2.x, ey: p2.y });
    }
    return segs;
}

/**
 * Compute cubic bezier control points for a CLOSED Catmull-Rom spline.
 * Wraps neighbor lookups so the curve smoothly loops back to the start.
 * @private
 */
function _computeSplineSegmentsClosedCore(pts, tension) {
    const segs = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = pts[(i + 2) % n];

        const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
        const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
        const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
        const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

        segs.push({ cp1x, cp1y, cp2x, cp2y, ex: p2.x, ey: p2.y });
    }
    return segs;
}

/**
 * Compute cubic bezier control points for a Catmull-Rom-style spline.
 * Results are memoized by point positions + tension + closed flag.
 * @param {Array} pts
 * @param {number} tension
 * @param {boolean} [closed=false]
 */
function _computeSplineSegments(pts, tension, closed = false) {
    const key = (closed ? 'C|' : 'O|') + _splineCacheKey(pts, tension);
    const cached = _splineCache.get(key);
    if (cached) return cached;

    const segs = closed
        ? _computeSplineSegmentsClosedCore(pts, tension)
        : _computeSplineSegmentsCore(pts, tension);

    // Evict oldest half when cache is full
    if (_splineCache.size >= _SPLINE_CACHE_MAX) {
        const keys = [..._splineCache.keys()];
        for (let i = 0; i < keys.length >> 1; i++) {
            _splineCache.delete(keys[i]);
        }
    }
    _splineCache.set(key, segs);
    return segs;
}

function _drawSmoothCurve(ctx, pts, tension, closed = false) {
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2 && !closed) {
        ctx.lineTo(pts[1].x, pts[1].y);
        return;
    }
    const segs = _computeSplineSegments(pts, tension, closed);
    for (const s of segs) {
        ctx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.ex, s.ey);
    }
}

/** Distance from point (px,py) to line segment (ax,ay)–(bx,by). */
function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * ShapeEditor — manages vector shapes drawn on skeleton nodes.
 * All coordinates are stored as 0–1 fractions of canvas width/height.
 */
export class ShapeEditor {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.shapes = [];

        this.activeTool    = SHAPE_TYPES.POLYLINE;
        this.activeShapeId = null;
        this._selectedShapeId = null;
        /** Index of the selected point within the selected shape (null = whole shape). */
        this.selectedPointIndex = null;
        this.strokeWidth   = 30;
        this.editorStrokeWidth = 10;
        this.lineCap       = 'round';
        this.lineJoin      = 'round';
        this.tangencyStrength = DEFAULT_TANGENCY;

        /** Shape currently under the mouse cursor (for hover highlight). */
        this.hoveredShapeId = null;

        /** Drag state: { shapeId, pointIndex } or null. */
        this._dragging = null;

        /**
         * Drawing mode — true when actively placing points for a new shape.
         * Only entered via startNewShape(), exited via finishActiveShape().
         */
        this._drawingMode = false;

        /** When true, new points are prepended (inserted at index 0). */
        this._extendFromStart = false;

        /**
         * Snap targets — array of { x, y, name } in 0–1 fractions.
         */
        this.snapTargets = [];

        /**
         * Join flags — endpoints flagged to connect with other flagged endpoints.
         * Set of "shapeId:pointIndex" strings. Only first/last points qualify.
         */
        this.joinFlags = new Set();

        /** Callbacks */
        this.onSnap = null;
        this.onPointDeleted = null;
        this.onPointMoved = null;
        /** Called with (shapeId, pointIndex) when a point is prepended (indices shifted). */
        this.onPointPrepended = null;
        /** Called with (isDrawing: boolean) when mode changes. */
        this.onDrawingChange = null;
        /** Called with (shapeId: number|null) when selection changes. */
        this.onSelectionChange = null;

        this._onMouseDown   = this._onMouseDown.bind(this);
        this._onMouseMove   = this._onMouseMove.bind(this);
        this._onMouseUp     = this._onMouseUp.bind(this);
        this._onContextMenu = this._onContextMenu.bind(this);
        this._onDblClick    = this._onDblClick.bind(this);
        this._onKeyDown     = this._onKeyDown.bind(this);

        canvas.addEventListener('mousedown',   this._onMouseDown);
        canvas.addEventListener('mousemove',   this._onMouseMove);
        canvas.addEventListener('mouseup',     this._onMouseUp);
        canvas.addEventListener('contextmenu', this._onContextMenu);
        canvas.addEventListener('dblclick',    this._onDblClick);
        window.addEventListener('keydown',     this._onKeyDown);
    }

    /* ── Selection (getter/setter with change callback) ──────────────── */

    get selectedShapeId() { return this._selectedShapeId; }
    set selectedShapeId(val) {
        if (val !== this._selectedShapeId) {
            this._selectedShapeId = val;
            this.selectedPointIndex = null;
            if (this.onSelectionChange) this.onSelectionChange(val);
        }
    }

    /* ── Mode ─────────────────────────────────────────────────────────── */

    /** Whether the editor is in draw mode (placing points). */
    isDrawing() {
        return this._drawingMode;
    }

    _notifyDrawingChange() {
        if (this.onDrawingChange) this.onDrawingChange(this._drawingMode);
    }

    /**
     * Enter draw mode — start building a new shape of the current tool type.
     * For dots: next node click places the dot and auto-finishes.
     * For polylines/arcs: clicks add points until finishActiveShape() is called.
     */
    startNewShape() {
        this.finishActiveShape();
        this.selectedShapeId = null;
        this.hoveredShapeId = null;
        this._drawingMode = true;
        this._notifyDrawingChange();
    }

    /**
     * Enter draw mode to extend an existing shape — new clicks add points
     * to the end (or start) of the given shape. For dots: no-op.
     * @param {number} shapeId
     * @param {boolean} [fromStart=false] — if true, prepend points at index 0
     */
    extendShape(shapeId, fromStart = false) {
        const shape = this._getShape(shapeId);
        if (!shape || shape.type === SHAPE_TYPES.DOT) return false;
        // Clean up any in-progress drawing first
        if (this.activeShapeId && this.activeShapeId !== shapeId) {
            this.finishActiveShape();
        }
        this.activeShapeId = shapeId;
        this._extendFromStart = fromStart;
        this.selectedShapeId = null;
        this._drawingMode = true;
        this._notifyDrawingChange();
        return true;
    }

    /* ── Tool / stroke ────────────────────────────────────────────────── */

    setTool(type) {
        // Don't finish active shape — just change the tool type.
        // If drawing, the next point will use the old shape's type anyway.
        this.activeTool = type;
    }

    setStrokeWidth(w) {
        this.strokeWidth = w;
        for (const shape of this.shapes) {
            shape.strokeWidth = w;
        }
    }

    setLineCap(cap) {
        this.lineCap = cap;
        for (const shape of this.shapes) {
            shape.lineCap = cap;
        }
    }

    setLineJoin(join) {
        this.lineJoin = join;
        for (const shape of this.shapes) {
            shape.lineJoin = join;
        }
    }

    setTangencyStrength(val) {
        this.tangencyStrength = val;
        for (const shape of this.shapes) {
            if (shape.type === SHAPE_TYPES.ARC) {
                shape.tangency = val;
            }
        }
    }

    clearAll() {
        this.shapes = [];
        this.activeShapeId = null;
        this.selectedShapeId = null;
        this.selectedPointIndex = null;
        this.hoveredShapeId = null;
        this._dragging = null;
        this._drawingMode = false;
        this._extendFromStart = false;
        this.joinFlags.clear();
        this._notifyDrawingChange();
    }

    /* ── Coordinate helpers ───────────────────────────────────────────── */

    _toFrac(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
        };
    }

    _hitTestPoint(fx, fy, radius = 0.03, restrictToShapeId = null) {
        for (const shape of this.shapes) {
            if (restrictToShapeId != null && shape.id !== restrictToShapeId) continue;
            for (let i = 0; i < shape.points.length; i++) {
                const p = shape.points[i];
                const dx = p.x - fx;
                const dy = p.y - fy;
                if (Math.sqrt(dx * dx + dy * dy) < radius) {
                    return { shapeId: shape.id, pointIndex: i };
                }
            }
        }
        return null;
    }

    _hitTestSegment(fx, fy, threshold = 0.04) {
        let bestId = null;
        let bestDist = Infinity;

        for (const shape of this.shapes) {
            let dist = Infinity;

            if (shape.type === SHAPE_TYPES.DOT && shape.points.length >= 1) {
                dist = Math.hypot(shape.points[0].x - fx, shape.points[0].y - fy);
            } else {
                for (let i = 0; i < shape.points.length - 1; i++) {
                    const a = shape.points[i];
                    const b = shape.points[i + 1];
                    const d = pointToSegmentDist(fx, fy, a.x, a.y, b.x, b.y);
                    if (d < dist) dist = d;
                }
            }

            if (dist < threshold && dist < bestDist) {
                bestDist = dist;
                bestId = shape.id;
            }
        }
        return bestId;
    }

    _getShape(id) {
        return this.shapes.find((s) => s.id === id) ?? null;
    }

    /* ── Snap targets (skeleton nodes) ────────────────────────────────── */

    setSnapTargets(keypoints, canvasW, canvasH) {
        if (!keypoints?.length) { this.snapTargets = []; return; }
        this.snapTargets = keypoints
            .filter((kp) => kp.confidence >= 0.3)
            .map((kp) => ({ x: kp.x / canvasW, y: kp.y / canvasH, name: kp.name, skeletonIndex: kp.skeletonIndex ?? 0 }));
    }

    _findNode(fx, fy) {
        const SNAP_RADIUS = 0.06;
        let closest = null;
        let closestDist = Infinity;
        for (const t of this.snapTargets) {
            const dx = t.x - fx;
            const dy = t.y - fy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < SNAP_RADIUS && dist < closestDist) {
                closest = t;
                closestDist = dist;
            }
        }
        return closest;
    }

    /* ── Mouse interaction ────────────────────────────────────────────── */

    _lockedShapeId() {
        if (this._drawingMode) return this.activeShapeId;
        return this.activeShapeId ?? this.selectedShapeId;
    }

    _onMouseDown(e) {
        if (e.button === 2) return; // right-click handled in contextmenu
        const raw = this._toFrac(e.clientX, e.clientY);

        // ── EDIT MODE ──
        if (!this._drawingMode) {
            // If a shape is selected, try dragging its points
            if (this.selectedShapeId) {
                const hit = this._hitTestPoint(raw.x, raw.y, 0.03, this.selectedShapeId);
                if (hit) {
                    this._dragging = { shapeId: hit.shapeId, pointIndex: hit.pointIndex };
                    this.selectedPointIndex = hit.pointIndex;
                    if (this.onSelectionChange) this.onSelectionChange(this.selectedShapeId);
                    e.preventDefault();
                    return;
                }
            }

            // Try hitting any point (starts drag + selects its shape)
            const pointHit = this._hitTestPoint(raw.x, raw.y);
            if (pointHit) {
                this._dragging = { shapeId: pointHit.shapeId, pointIndex: pointHit.pointIndex };
                this._selectedShapeId = pointHit.shapeId;
                this.selectedPointIndex = pointHit.pointIndex;
                if (this.onSelectionChange) this.onSelectionChange(pointHit.shapeId);
                e.preventDefault();
                return;
            }

            // Try selecting a shape by its segment (clears point selection)
            const segId = this._hitTestSegment(raw.x, raw.y);
            if (segId) {
                this.selectedShapeId = segId;
                e.preventDefault();
                return;
            }

            // Click on empty space → deselect
            this.selectedShapeId = null;
            return;
        }

        // ── DRAW MODE ──
        // Allow dragging existing points of the active shape,
        // BUT check for close-loop first (clicking the opposite endpoint).
        if (this.activeShapeId) {
            const hit = this._hitTestPoint(raw.x, raw.y, 0.03, this.activeShapeId);
            if (hit) {
                const shape = this._getShape(this.activeShapeId);
                if (shape && shape.type !== SHAPE_TYPES.DOT && shape.points.length >= 3) {
                    const closingIndex = this._extendFromStart
                        ? shape.points.length - 1 : 0;
                    if (hit.pointIndex === closingIndex) {
                        shape.closed = true;
                        this.finishActiveShape();
                        e.preventDefault();
                        return;
                    }
                }
                this._dragging = { shapeId: hit.shapeId, pointIndex: hit.pointIndex };
                e.preventDefault();
                return;
            }
        }

        // Must click on a node to place a point
        const node = this._findNode(raw.x, raw.y);
        if (!node) return;

        e.preventDefault();
        const { x, y } = node;

        if (this.activeTool === SHAPE_TYPES.DOT) {
            // Dots are single-point — create and auto-finish
            const shape = createShape(SHAPE_TYPES.DOT, [{ x, y }],
                this.strokeWidth, this.lineCap, this.lineJoin, null);
            this.shapes.push(shape);
            if (this.onSnap) this.onSnap(shape.id, 0, node.name, node.skeletonIndex);
            this._drawingMode = false;
            this.activeShapeId = null;
            this._notifyDrawingChange();
        } else if (!this.activeShapeId) {
            // First point → create the shape
            const tangency = this.activeTool === SHAPE_TYPES.ARC ? this.tangencyStrength : null;
            const shape = createShape(this.activeTool, [{ x, y }],
                this.strokeWidth, this.lineCap, this.lineJoin, tangency);
            this.shapes.push(shape);
            this.activeShapeId = shape.id;
            if (this.onSnap) this.onSnap(shape.id, 0, node.name, node.skeletonIndex);
        } else {
            // Subsequent points → add to active shape
            const shape = this._getShape(this.activeShapeId);
            if (shape) {
                if (this._extendFromStart) {
                    shape.points.unshift({ x, y });
                    this._shiftJoinFlags(shape.id, -1, 1); // shift all join flags up by 1
                    if (this.onPointPrepended) this.onPointPrepended(shape.id, 0);
                    if (this.onSnap) this.onSnap(shape.id, 0, node.name, node.skeletonIndex);
                } else {
                    shape.points.push({ x, y });
                    if (this.onSnap) this.onSnap(shape.id, shape.points.length - 1, node.name, node.skeletonIndex);
                }
            }
        }
    }

    _onMouseMove(e) {
        const raw = this._toFrac(e.clientX, e.clientY);

        if (this._dragging) {
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        // DRAW MODE: crosshair on nodes, grab on active shape points
        if (this._drawingMode) {
            if (this.activeShapeId) {
                const hit = this._hitTestPoint(raw.x, raw.y, 0.03, this.activeShapeId);
                if (hit) { this.canvas.style.cursor = 'grab'; return; }
            }
            const node = this._findNode(raw.x, raw.y);
            this.canvas.style.cursor = node ? 'crosshair' : '';
            this.hoveredShapeId = null;
            return;
        }

        // EDIT MODE: hover shapes, grab on points
        if (this.selectedShapeId) {
            const hit = this._hitTestPoint(raw.x, raw.y, 0.03, this.selectedShapeId);
            this.canvas.style.cursor = hit ? 'grab' : '';
            this.hoveredShapeId = null;
            return;
        }

        const pointHit = this._hitTestPoint(raw.x, raw.y);
        if (pointHit) {
            this.canvas.style.cursor = 'grab';
            this.hoveredShapeId = pointHit.shapeId;
            return;
        }

        const segmentId = this._hitTestSegment(raw.x, raw.y);
        if (segmentId) {
            this.hoveredShapeId = segmentId;
            this.canvas.style.cursor = 'pointer';
        } else {
            this.hoveredShapeId = null;
            this.canvas.style.cursor = '';
        }
    }

    _onMouseUp(e) {
        if (!this._dragging) return;
        const raw = this._toFrac(e.clientX, e.clientY);
        const node = this._findNode(raw.x, raw.y);

        if (node) {
            const shape = this._getShape(this._dragging.shapeId);
            if (shape) {
                shape.points[this._dragging.pointIndex] = { x: node.x, y: node.y };
                if (this.onPointMoved) {
                    this.onPointMoved(this._dragging.shapeId, this._dragging.pointIndex, node.name, node.skeletonIndex);
                }
            }
        }
        // If not dropped on a node, point stays where it was (snap back)

        this._dragging = null;
        this.canvas.style.cursor = '';
    }

    _onDblClick(e) {
        e.preventDefault();
        if (this._drawingMode) {
            this.finishActiveShape();
        }
    }

    _onKeyDown(e) {
        if (e.key === 'Escape') {
            if (this._drawingMode) {
                this.finishActiveShape();
            } else if (this.selectedShapeId) {
                this.selectedShapeId = null;
            }
        } else if (e.key === 'Enter') {
            if (this._drawingMode) {
                this.finishActiveShape();
            }
        } else if (e.key === 'Backspace' && !this._drawingMode) {
            // Skip if user is typing in an input field
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            // Delete the selected point
            if (this.selectedShapeId != null && this.selectedPointIndex != null) {
                e.preventDefault();
                const shape = this._getShape(this.selectedShapeId);
                if (!shape) return;

                // Remove join flag if present
                this.joinFlags.delete(`${shape.id}:${this.selectedPointIndex}`);

                if (this.onPointDeleted) this.onPointDeleted(shape.id, this.selectedPointIndex);
                shape.points.splice(this.selectedPointIndex, 1);

                // Update join flags: shift indices above the deleted point
                this._shiftJoinFlags(shape.id, this.selectedPointIndex, -1);

                // Auto-open closed shapes that drop below 3 points
                if (shape.closed && shape.points.length < 3) {
                    shape.closed = false;
                }
                // Remove shape if too few points
                const minPoints = shape.type === SHAPE_TYPES.DOT ? 1 : 2;
                if (shape.points.length < minPoints) {
                    this._removeJoinFlagsForShape(shape.id);
                    this.shapes = this.shapes.filter((s) => s.id !== shape.id);
                    this.selectedShapeId = null;
                } else {
                    // Adjust selection
                    if (this.selectedPointIndex >= shape.points.length) {
                        this.selectedPointIndex = shape.points.length - 1;
                    }
                    if (this.onSelectionChange) this.onSelectionChange(this.selectedShapeId);
                }
            }
        }
    }

    /**
     * Right-click: in edit mode, toggle join flag on endpoints.
     * In draw mode, finish/cancel the active shape.
     */
    _onContextMenu(e) {
        e.preventDefault();
        const raw = this._toFrac(e.clientX, e.clientY);

        if (this._drawingMode) {
            // Right-click during drawing → finish
            this.finishActiveShape();
            return;
        }

        // Edit mode: toggle join flag on endpoint
        const restrictTo = this.selectedShapeId || null;
        const hit = this._hitTestPoint(raw.x, raw.y, 0.03, restrictTo);

        if (hit) {
            const shape = this._getShape(hit.shapeId);
            if (!shape) return;

            // Only first and last points can be flagged (endpoints)
            const isEndpoint = hit.pointIndex === 0 || hit.pointIndex === shape.points.length - 1;
            if (!isEndpoint && shape.type !== SHAPE_TYPES.DOT) return;

            const key = `${hit.shapeId}:${hit.pointIndex}`;
            if (this.joinFlags.has(key)) {
                this.joinFlags.delete(key);
            } else {
                this.joinFlags.add(key);
            }

            // Select the shape and point
            this._selectedShapeId = hit.shapeId;
            this.selectedPointIndex = hit.pointIndex;
            if (this.onSelectionChange) this.onSelectionChange(hit.shapeId);
        } else if (this.selectedShapeId) {
            // Right-click empty → deselect
            this.selectedShapeId = null;
        }
    }

    /**
     * Finish the shape being drawn. Removes it if too few points.
     * Exits drawing mode.
     */
    finishActiveShape() {
        if (this.activeShapeId) {
            const shape = this._getShape(this.activeShapeId);
            if (shape && shape.type !== SHAPE_TYPES.DOT && shape.points.length < 2) {
                // Not enough points — discard
                this._removeJoinFlagsForShape(shape.id);
                this.shapes = this.shapes.filter((s) => s.id !== shape.id);
            }
            this.activeShapeId = null;
        }
        this.selectedShapeId = null;
        this._extendFromStart = false;
        if (this._drawingMode) {
            this._drawingMode = false;
            this._notifyDrawingChange();
        }
    }

    /* ── Join flag helpers ─────────────────────────────────────────────── */

    _removeJoinFlagsForShape(shapeId) {
        for (const key of [...this.joinFlags]) {
            if (key.startsWith(`${shapeId}:`)) this.joinFlags.delete(key);
        }
    }

    /** Shift join flag indices for a shape after insert/delete. */
    _shiftJoinFlags(shapeId, fromIndex, delta) {
        const toRemove = [];
        const toAdd = [];
        for (const key of this.joinFlags) {
            const [sid, pidx] = key.split(':');
            if (Number(sid) === shapeId && Number(pidx) > fromIndex) {
                toRemove.push(key);
                toAdd.push(`${shapeId}:${Number(pidx) + delta}`);
            }
        }
        for (const k of toRemove) this.joinFlags.delete(k);
        for (const k of toAdd) this.joinFlags.add(k);
    }

    /** Check if a point is flagged for joining. */
    isJoinFlagged(shapeId, pointIndex) {
        return this.joinFlags.has(`${shapeId}:${pointIndex}`);
    }

    getJoinFlags() {
        return [...this.joinFlags];
    }

    loadJoinFlags(flags) {
        this.joinFlags = new Set(flags || []);
    }

    deselectShape() {
        this.selectedShapeId = null;
    }

    /* ── Rendering ────────────────────────────────────────────────────── */

    /**
     * Draw all shapes on the editor canvas.
     *
     * Visual states:
     *   - Default: dark stroke, subtle control points
     *   - Hovered: blue highlight, other shapes dimmed (only when no shape is locked)
     *   - Selected: blue highlight, other shapes dimmed, control points prominent
     *   - Active (building): blue highlight, other shapes dimmed
     *
     * Editor always uses editorStrokeWidth (default 10px), not the viewport strokeWidth.
     */
    draw(deformedPoints) {
        const ctx = this.ctx;
        const w   = this.canvas.width;
        const h   = this.canvas.height;
        const hovered  = this.hoveredShapeId;
        const selected = this.selectedShapeId;
        const active   = this.activeShapeId;
        const locked   = this._lockedShapeId();

        for (const shape of this.shapes) {
            const pts = shape.points.map((p, i) => {
                const override = deformedPoints?.[shape.id]?.[i];
                return {
                    x: (override ? override.x : p.x) * w,
                    y: (override ? override.y : p.y) * h,
                };
            });

            ctx.save();

            const isActive   = shape.id === active;
            const isSelected = shape.id === selected;
            const isHovered  = shape.id === hovered && !locked;

            // Dim non-focused shapes
            if (locked) {
                ctx.globalAlpha = (isActive || isSelected) ? 1.0 : 0.15;
            } else if (hovered != null) {
                ctx.globalAlpha = isHovered ? 1.0 : 0.2;
            }

            const isHighlighted = isActive || isSelected || isHovered;
            ctx.strokeStyle = isHighlighted ? '#1446FF' : '#222';
            ctx.fillStyle   = isHighlighted ? '#1446FF' : '#222';
            ctx.lineWidth   = this.editorStrokeWidth;
            ctx.lineCap     = shape.lineCap || 'round';
            ctx.lineJoin    = shape.lineJoin || 'round';

            if (shape.type === SHAPE_TYPES.DOT && pts.length >= 1) {
                ctx.beginPath();
                ctx.arc(pts[0].x, pts[0].y, this.editorStrokeWidth / 2, 0, Math.PI * 2);
                ctx.fill();
            } else if (shape.type === SHAPE_TYPES.ARC && pts.length >= 2) {
                ctx.beginPath();
                _drawSmoothCurve(ctx, pts, shape.tangency ?? DEFAULT_TANGENCY, shape.closed);
                if (shape.closed) ctx.closePath();
                ctx.stroke();
            } else if (shape.type === SHAPE_TYPES.POLYLINE && pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i].x, pts[i].y);
                }
                if (shape.closed) ctx.closePath();
                ctx.stroke();
            }

            // Draw control point handles
            const showHandles = isHighlighted || !locked;
            if (showHandles) {
                for (let pi = 0; pi < pts.length; pi++) {
                    const p = pts[pi];
                    const isSelectedPoint = isSelected && this.selectedPointIndex === pi;
                    const isJoined = this.joinFlags.has(`${shape.id}:${pi}`);

                    ctx.beginPath();
                    if (isSelectedPoint) {
                        // Distinctly highlighted selected point
                        ctx.fillStyle = '#1446FF';
                        ctx.strokeStyle = '#fff';
                        ctx.lineWidth = 2;
                        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    } else if (isSelected || isActive) {
                        ctx.fillStyle = '#fff';
                        ctx.strokeStyle = '#1446FF';
                        ctx.lineWidth = 2;
                        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    } else if (isHovered) {
                        ctx.fillStyle = '#1446FF';
                        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        ctx.fillStyle = 'rgba(20, 70, 255, 0.4)';
                        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    // Join flag indicator — diamond marker
                    if (isJoined) {
                        ctx.save();
                        ctx.strokeStyle = '#E53935';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(p.x, p.y - 10);
                        ctx.lineTo(p.x + 7, p.y);
                        ctx.lineTo(p.x, p.y + 10);
                        ctx.lineTo(p.x - 7, p.y);
                        ctx.closePath();
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            }

            ctx.restore();
        }
    }

    /* ── Serialization ────────────────────────────────────────────────── */

    getShapes() {
        return JSON.parse(JSON.stringify(this.shapes));
    }

    loadShapes(data) {
        this.shapes = data;
        nextId = Math.max(...data.map((s) => s.id), 0) + 1;
        this.activeShapeId = null;
        this.selectedShapeId = null;
        this.selectedPointIndex = null;
        this.hoveredShapeId = null;
        this._dragging = null;
        this._drawingMode = false;
        this._extendFromStart = false;
        this._notifyDrawingChange();
    }
}

/** Re-export spline math for fontExport.js and app.js viewport rendering.
 *  Signature: computeSplineSegments(pts, tension, closed = false) */
export { _computeSplineSegments as computeSplineSegments };

/**
 * Build chains of shapes connected by join flags.
 * Returns { chains, chainedIds } where:
 *   chains: Array of [{ shapeId, reversed }, …] — ordered shapes per chain
 *   chainedIds: Set of shape IDs that belong to a chain
 *
 * @param {Array} shapes — shape objects with .id and .points
 * @param {Array} joinFlags — array of "shapeId:pointIndex" strings
 * @param {function(number,number): string|null} getBinding — (shapeId, pointIndex) → keypoint name
 */
export function buildJoinChains(shapes, joinFlags, getBinding) {
    if (!joinFlags?.length) return { chains: [], chainedIds: new Set() };

    // Parse flags into endpoint descriptors
    const flagged = [];
    for (const key of joinFlags) {
        const [sid, pidx] = key.split(':');
        const shapeId = Number(sid);
        const pointIndex = Number(pidx);
        const shape = shapes.find((s) => s.id === shapeId);
        if (!shape) continue;
        const isStart = pointIndex === 0;
        const binding = getBinding(shapeId, pointIndex);
        flagged.push({ shapeId, pointIndex, isStart, binding });
    }

    // Group by binding keypoint (or by position key for unbound)
    const groups = {};
    for (const f of flagged) {
        const gk = f.binding || `unbound-${f.shapeId}-${f.pointIndex}`;
        if (!groups[gk]) groups[gk] = [];
        groups[gk].push(f);
    }

    // Build adjacency between shape-ends (only for groups with exactly 2 endpoints)
    // Node format: "shapeId:s" (start) or "shapeId:e" (end)
    const adj = {};
    for (const entries of Object.values(groups)) {
        if (entries.length !== 2) continue;
        const [a, b] = entries;
        if (a.shapeId === b.shapeId) continue;
        const aNode = `${a.shapeId}:${a.isStart ? 's' : 'e'}`;
        const bNode = `${b.shapeId}:${b.isStart ? 's' : 'e'}`;
        adj[aNode] = bNode;
        adj[bNode] = aNode;
    }

    // Walk chains
    const visitedShapes = new Set();
    const chains = [];

    for (const startNode of Object.keys(adj)) {
        const startShapeId = Number(startNode.split(':')[0]);
        if (visitedShapes.has(startShapeId)) continue;

        // Walk backwards to find chain head.
        // From the current entry port, follow adj[port] to the previous shape's
        // exit port, then flip to its entry port (other end), and repeat.
        let head = startNode;
        const seen = new Set([startShapeId]);
        while (true) {
            const backConn = adj[head];
            if (!backConn) break;
            const [bSid, bEnd] = backConn.split(':');
            const bShapeId = Number(bSid);
            if (seen.has(bShapeId)) break;
            seen.add(bShapeId);
            head = `${bSid}:${bEnd === 's' ? 'e' : 's'}`;
        }

        // Walk forward from head to build the chain
        const chain = [];
        let node = head;
        while (node) {
            const [nSid, nEnd] = node.split(':');
            const shapeId = Number(nSid);
            if (visitedShapes.has(shapeId)) break;
            visitedShapes.add(shapeId);
            // If we entered at the 'end' side, reverse the shape's points
            const reversed = nEnd === 'e';
            chain.push({ shapeId, reversed });
            // Exit via the other end of this shape
            const exitEnd = nEnd === 's' ? 'e' : 's';
            const exitNode = `${shapeId}:${exitEnd}`;
            const next = adj[exitNode];
            if (!next || visitedShapes.has(Number(next.split(':')[0]))) break;
            node = next;
        }

        if (chain.length >= 2) chains.push(chain);
    }

    const chainedIds = new Set();
    for (const chain of chains) {
        for (const { shapeId } of chain) chainedIds.add(shapeId);
    }

    return { chains, chainedIds };
}
