/**
 * camera.js — Webcam initialisation and cover-crop math.
 */

/**
 * Request the user camera and wire it to a <video> element.
 * Resolves once video metadata is loaded and playback has started.
 * @param {HTMLVideoElement} videoEl
 */
export async function initCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
    });
    videoEl.srcObject = stream;
    return new Promise((resolve) => {
        videoEl.onloadedmetadata = () => {
            videoEl.width  = videoEl.videoWidth;
            videoEl.height = videoEl.videoHeight;
            videoEl.play();
            resolve();
        };
    });
}

/**
 * Compute the source-rect crop for fill / fit modes.
 * Returns { sx, sy, srcW, srcH }.
 *
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {number} videoW
 * @param {number} videoH
 * @param {boolean} fillMode — true = cover-crop, false = letterbox
 */
export function computeCrop(canvasW, canvasH, videoW, videoH, fillMode) {
    if (fillMode) {
        const canvasAspect = canvasW / canvasH;
        const videoAspect  = videoW / videoH;

        if (canvasAspect > videoAspect) {
            const srcW = videoW;
            const srcH = videoW / canvasAspect;
            return { sx: 0, sy: (videoH - srcH) / 2, srcW, srcH };
        } else {
            const srcH = videoH;
            const srcW = videoH * canvasAspect;
            return { sx: (videoW - srcW) / 2, sy: 0, srcW, srcH };
        }
    }

    return { sx: 0, sy: 0, srcW: videoW, srcH: videoH };
}
