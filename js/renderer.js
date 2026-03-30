/**
 * renderer.js — Stickman drawing
 * Renders a skeleton figure from COCO-format keypoints.
 * Supports different rendering modes via options.
 */

export const SKELETON = [
    ['left_shoulder',  'right_shoulder'],
    ['left_shoulder',  'left_hip'],
    ['right_shoulder', 'right_hip'],
    ['left_hip',       'right_hip'],
    ['left_shoulder',  'left_elbow'],
    ['left_elbow',     'left_wrist'],
    ['right_shoulder', 'right_elbow'],
    ['right_elbow',    'right_wrist'],
    ['left_hip',       'left_knee'],
    ['left_knee',      'left_ankle'],
    ['right_hip',      'right_knee'],
    ['right_knee',     'right_ankle'],
];

export const MIN_CONFIDENCE = 0.3;

/**
 * Draw a stickman on `ctx`.
 * Keypoints must already be scaled/mirrored to canvas coordinates.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} keypoints
 * @param {Object} [opts]
 * @param {string} [opts.color='rgb(34, 34, 34)'] — bone/head color
 * @param {string} [opts.jointColor] — joint dot color (defaults to opts.color)
 * @param {number} [opts.boneWidth=3] — bone line width
 * @param {number} [opts.jointRadius=5] — joint dot radius
 * @param {boolean} [opts.drawBones=true] — draw bone connections
 * @param {boolean} [opts.drawHead=true] — draw head circle
 */
export function drawStickman(ctx, keypoints, opts = {}) {
    if (!keypoints?.length) return;

    const color       = opts.color ?? 'rgb(34, 34, 34)';
    const jointColor  = opts.jointColor ?? color;
    const boneWidth   = opts.boneWidth ?? 3;
    const jointRadius = opts.jointRadius ?? 5;
    const drawBones   = opts.drawBones !== false;
    const drawHead    = opts.drawHead !== false;

    const kp = {};
    for (const p of keypoints) kp[p.name] = p;

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // Bones
    if (drawBones) {
        ctx.strokeStyle = color;
        ctx.lineWidth   = boneWidth;
        for (const [a, b] of SKELETON) {
            if (!kp[a] || !kp[b]) continue;
            if (kp[a].confidence < MIN_CONFIDENCE || kp[b].confidence < MIN_CONFIDENCE) continue;
            ctx.beginPath();
            ctx.moveTo(kp[a].x, kp[a].y);
            ctx.lineTo(kp[b].x, kp[b].y);
            ctx.stroke();
        }
    }

    // Joints
    if (jointRadius > 0) {
        ctx.fillStyle = jointColor;
        for (const p of keypoints) {
            if (p.confidence < MIN_CONFIDENCE) continue;
            ctx.beginPath();
            ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Head — sized from ear-to-ear distance
    if (drawHead && kp.nose?.confidence >= MIN_CONFIDENCE) {
        let r = 30;
        if (kp.left_ear?.confidence >= MIN_CONFIDENCE &&
            kp.right_ear?.confidence >= MIN_CONFIDENCE) {
            r = Math.abs(kp.left_ear.x - kp.right_ear.x) * 0.65;
        }
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth   = boneWidth;
        ctx.arc(kp.nose.x, kp.nose.y - r * 0.3, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draw a name label above a skeleton's head.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} keypoints
 * @param {string} label — e.g. 'Ficarra', 'Picone'
 * @param {Object} [opts]
 * @param {string} [opts.color='#222']
 * @param {number} [opts.fontSize] — auto-calculated from head size if not set
 */
export function drawSkeletonLabel(ctx, keypoints, label, opts = {}) {
    if (!keypoints?.length) return;
    const color    = opts.color ?? '#222';
    const fontSize = opts.fontSize ?? null;

    const kp = {};
    for (const p of keypoints) kp[p.name] = p;

    const nose = kp.nose;
    if (!nose || nose.confidence < MIN_CONFIDENCE) return;

    let headR = 30;
    if (kp.left_ear?.confidence >= MIN_CONFIDENCE &&
        kp.right_ear?.confidence >= MIN_CONFIDENCE) {
        headR = Math.abs(kp.left_ear.x - kp.right_ear.x) * 0.65;
    }

    const size = fontSize ?? Math.max(11, Math.round(headR * 0.7));

    ctx.save();
    ctx.font         = `600 ${size}px "Innovator Grotesk", sans-serif`;
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, nose.x, nose.y - headR - 4);
    ctx.restore();
}
