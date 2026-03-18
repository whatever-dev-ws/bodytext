/**
 * pose.js — Pose detection via TensorFlow.js MoveNet MultiPose Lightning
 *
 * Double-buffered architecture: the detection loop runs decoupled from the
 * render loop (via setTimeout, not rAF). It writes to a back buffer, then
 * atomically publishes results to the front buffer. The render loop reads
 * the front buffer without blocking — if inference takes 15ms, rendering
 * still runs at 60fps using the previous frame's poses.
 *
 * Supports up to MAX_POSES simultaneous detected bodies.
 */

const MAX_POSES = 6;
/** Target detection rate — 30fps is plenty for smooth pose tracking. */
const TARGET_DETECT_MS = 1000 / 30;

export class PoseDetector {
    constructor() {
        this.detector = null;
        this.ready    = false;
        this.backend  = null;
        this._video   = null;
        this._running = false;

        /** @private Front buffer — read by render loop via getPoses(). */
        this._frontBuffer = [];
        /** @private Monotonic frame counter for staleness checks. */
        this._frameId = 0;
    }

    /**
     * Load MoveNet MultiPose Lightning and start detecting on the given <video>.
     * Tries WebGPU first, falls back to WebGL, then WASM as last resort.
     */
    async init(video) {
        this._video = video;

        // Backend priority: WebGPU → WebGL → WASM (broadest compatibility)
        const backends = ['webgpu', 'webgl', 'wasm'];
        for (const name of backends) {
            try {
                await tf.setBackend(name);
                await tf.ready();
                this.backend = name;
                break;
            } catch {
                // try next
            }
        }
        if (!this.backend) {
            throw new Error('No usable TF.js backend (tried webgpu, webgl, wasm)');
        }
        console.log(`[pose] TF.js backend: ${this.backend}`);

        this.detector = await poseDetection.createDetector(
            poseDetection.SupportedModels.MoveNet,
            { modelType: 'MultiPose.Lightning', enableSmoothing: false, minPoseScore: 0.2 },
        );

        this.ready    = true;
        this._running = true;
        this._detectLoop();
    }

    /**
     * Throttled detection loop — runs at TARGET_DETECT_MS (~30fps).
     * Decoupled from the display refresh rate so the render loop never
     * blocks on inference. If inference itself takes longer than the
     * target interval, it simply runs back-to-back without piling up.
     * @private
     */
    async _detectLoop() {
        while (this._running) {
            const t0 = performance.now();

            if (this._video.readyState >= 2) {
                try {
                    const results = await this.detector.estimatePoses(this._video);
                    this._frontBuffer = (results || []).slice(0, MAX_POSES);
                    this._frameId++;
                } catch {
                    // skip frame — front buffer retains last valid result
                }
            }

            // Sleep for the remainder of the target interval.
            // If inference already took longer, yield once (0ms) to avoid starving the event loop.
            const elapsed = performance.now() - t0;
            const delay = Math.max(0, TARGET_DETECT_MS - elapsed);
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    /** First detected pose, or null. */
    getPose() {
        return this._frontBuffer[0] ?? null;
    }

    /**
     * Keypoints of the first pose, or null.
     * Maps TF.js `score` to `confidence` for downstream compatibility.
     */
    getKeypoints() {
        const pose = this.getPose();
        if (!pose) return null;
        return pose.keypoints.map((kp) => ({ ...kp, confidence: kp.score }));
    }

    /**
     * All detected poses as arrays of keypoints with `confidence` mapped.
     * Returns an empty array when no poses are detected.
     */
    getPoses() {
        return this._frontBuffer.map((pose) =>
            pose.keypoints.map((kp) => ({ ...kp, confidence: kp.score }))
        );
    }

    /** Current inference frame counter (for optional staleness checks). */
    getFrameId() {
        return this._frameId;
    }

    /** Stop the detection loop. */
    stop() {
        this._running = false;
    }
}
