/**
 * bindings.js — Keypoint binding manager
 * Maps shape control points to COCO skeleton keypoints.
 * During live preview, bound control points follow their linked keypoints.
 */

/** Left↔Right mirror pairs for COCO keypoints. Center points map to themselves. */
export const KEYPOINT_MIRROR_MAP = {
    'nose':            'nose',
    'left_eye':        'right_eye',
    'right_eye':       'left_eye',
    'left_ear':        'right_ear',
    'right_ear':       'left_ear',
    'left_shoulder':   'right_shoulder',
    'right_shoulder':  'left_shoulder',
    'left_elbow':      'right_elbow',
    'right_elbow':     'left_elbow',
    'left_wrist':      'right_wrist',
    'right_wrist':     'left_wrist',
    'left_hip':        'right_hip',
    'right_hip':       'left_hip',
    'left_knee':       'right_knee',
    'right_knee':      'left_knee',
    'left_ankle':      'right_ankle',
    'right_ankle':     'left_ankle',
};

/**
 * BindingManager — associates { shapeId, pointIndex } pairs with keypoint names.
 */
export class BindingManager {
    constructor() {
        /** @type {Map<string, string>} key: "shapeId:pointIndex" → value: keypoint name */
        this.bindings = new Map();
        /** Cache of last-known-good override positions (prevents stuck segments). */
        this._lastOverrides = {};
    }

    /** Create a binding key from shape ID and point index. */
    _key(shapeId, pointIndex) {
        return `${shapeId}:${pointIndex}`;
    }

    /** Encode a skeleton-qualified binding value. */
    _encodeBinding(skeletonIndex, keypointName) {
        return `${skeletonIndex}:${keypointName}`;
    }

    /** Decode a binding value into { skeleton, keypoint }. */
    _decodeBinding(value) {
        const i = value.indexOf(':');
        if (i === -1) return { skeleton: 0, keypoint: value };
        return { skeleton: Number(value.substring(0, i)), keypoint: value.substring(i + 1) };
    }

    /**
     * Bind a shape control point to a keypoint.
     * @param {number} shapeId
     * @param {number} pointIndex
     * @param {string} keypointName — e.g. 'left_wrist', 'right_shoulder'
     * @param {number} [skeletonIndex=0] — 0 = A, 1 = B
     */
    bind(shapeId, pointIndex, keypointName, skeletonIndex = 0) {
        this.bindings.set(this._key(shapeId, pointIndex), this._encodeBinding(skeletonIndex, keypointName));
    }

    /**
     * Remove binding for a specific control point.
     */
    unbind(shapeId, pointIndex) {
        this.bindings.delete(this._key(shapeId, pointIndex));
    }

    /**
     * Remove all bindings for a given shape.
     */
    unbindShape(shapeId) {
        for (const key of [...this.bindings.keys()]) {
            if (key.startsWith(`${shapeId}:`)) {
                this.bindings.delete(key);
            }
        }
    }

    /**
     * Get the keypoint name bound to a given control point, or null.
     */
    getBinding(shapeId, pointIndex) {
        return this.bindings.get(this._key(shapeId, pointIndex)) ?? null;
    }

    /**
     * Apply bindings to produce deformed point positions from live keypoints.
     * Returns a map: { shapeId: { pointIndex: { x, y } } } with overrides
     * for bound points. Positions are in 0–1 canvas fractions.
     *
     * @param {Array<Array>} poseKeypoints — per-skeleton arrays of { name, x, y, confidence }
     * @param {number} canvasW
     * @param {number} canvasH
     */
    applyBindings(poseKeypoints, canvasW, canvasH) {
        if (!poseKeypoints?.some((kps) => kps?.length)) return this._lastOverrides;

        const kpMaps = poseKeypoints.map((kps) => {
            if (!kps?.length) return {};
            const map = {};
            for (const kp of kps) map[kp.name] = kp;
            return map;
        });

        const overrides = {};
        for (const [key, bindingValue] of this.bindings) {
            const [shapeIdStr, pointIndexStr] = key.split(':');
            const shapeId    = Number(shapeIdStr);
            const pointIndex = Number(pointIndexStr);

            const { skeleton, keypoint } = this._decodeBinding(bindingValue);
            const kp = kpMaps[skeleton]?.[keypoint];
            if (kp && kp.confidence >= 0.3) {
                if (!overrides[shapeId]) overrides[shapeId] = {};
                overrides[shapeId][pointIndex] = {
                    x: kp.x / canvasW,
                    y: kp.y / canvasH,
                };
            } else if (this._lastOverrides[shapeId]?.[pointIndex]) {
                // Hold last known good position instead of snapping back
                if (!overrides[shapeId]) overrides[shapeId] = {};
                overrides[shapeId][pointIndex] = this._lastOverrides[shapeId][pointIndex];
            }
        }

        this._lastOverrides = overrides;
        return overrides;
    }

    /**
     * Mirror all bindings: swap left↔right keypoint names and move
     * the corresponding shape control points to the mirrored keypoint
     * positions on the appropriate static skeleton.
     *
     * @param {Array} shapes — mutable shapes array (points will be moved in place)
     * @param {Array<Array>} staticSkeletons — per-skeleton arrays of { name, x, y } in 0–1 fractions
     */
    mirrorBindings(shapes, staticSkeletons) {
        const skeletonMaps = staticSkeletons.map((kps) => {
            const map = {};
            for (const kp of kps) map[kp.name] = kp;
            return map;
        });

        const newBindings = new Map();
        for (const [key, value] of this.bindings) {
            const { skeleton, keypoint } = this._decodeBinding(value);
            const mirroredName = KEYPOINT_MIRROR_MAP[keypoint] || keypoint;
            newBindings.set(key, this._encodeBinding(skeleton, mirroredName));

            // Move the control point to the mirrored keypoint position
            const [shapeIdStr, pointIndexStr] = key.split(':');
            const shape = shapes.find((s) => s.id === Number(shapeIdStr));
            const pt = shape?.points[Number(pointIndexStr)];
            const mirroredKp = skeletonMaps[skeleton]?.[mirroredName];
            if (pt && mirroredKp) {
                pt.x = mirroredKp.x;
                pt.y = mirroredKp.y;
            }
        }

        this.bindings = newBindings;
        this._lastOverrides = {};
    }

    /**
     * Shift all binding point indices for a shape — used when prepending points.
     * Indices >= fromIndex are incremented by delta.
     */
    shiftPointIndices(shapeId, fromIndex, delta) {
        const toUpdate = [];
        for (const [key, val] of this.bindings) {
            const [sid, pidx] = key.split(':');
            if (Number(sid) === shapeId && Number(pidx) >= fromIndex) {
                toUpdate.push({ oldKey: key, newIdx: Number(pidx) + delta, val });
            }
        }
        for (const { oldKey, newIdx, val } of toUpdate) {
            this.bindings.delete(oldKey);
            this.bindings.set(this._key(shapeId, newIdx), val);
        }
    }

    /* ── Serialization ────────────────────────────────────────────────── */

    getBindings() {
        const obj = {};
        for (const [key, val] of this.bindings) {
            obj[key] = val;
        }
        return obj;
    }

    loadBindings(data) {
        this.bindings.clear();
        this._lastOverrides = {};
        for (const [key, val] of Object.entries(data)) {
            this.bindings.set(key, val);
        }
    }

    clear() {
        this.bindings.clear();
        this._lastOverrides = {};
    }
}
