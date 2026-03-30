/**
 * audioSave.js — Hands-free letter saving via microphone threshold.
 *
 * Uses the Web Audio API to monitor mic input level.
 * When RMS exceeds the sensitivity threshold, fires the onSave callback
 * with a 1.5 s cooldown to avoid rapid re-triggers.
 */

import { showToast } from './toast.js';

let active      = false;
let context     = null;
let analyser    = null;
let sensitivity = 30;
let cooldown    = false;

/** DOM element refs — set once via init(). */
let _btnEl      = null;
let _controlsEl = null;
let _meterEl    = null;
let _onSave     = null;

/**
 * Wire up DOM elements and the save callback.
 * Call once at startup.
 *
 * @param {object} opts
 * @param {HTMLButtonElement} opts.buttonEl    — the toggle button
 * @param {HTMLElement}       opts.controlsEl  — container shown/hidden on toggle
 * @param {HTMLElement}       opts.meterFillEl — the meter bar fill div
 * @param {function(): void}  opts.onSave      — called when threshold is hit
 */
export function initAudioSave({ buttonEl, controlsEl, meterFillEl, onSave }) {
    _btnEl      = buttonEl;
    _controlsEl = controlsEl;
    _meterEl    = meterFillEl;
    _onSave     = onSave;
}

/** Update the sensitivity threshold (0–100). */
export function setSensitivity(val) {
    sensitivity = val;
}

/** Whether audio monitoring is currently active. */
export function isActive() {
    return active;
}

/**
 * Toggle audio monitoring on/off.
 * On first activation, requests microphone permission.
 */
export async function toggleAudioSave() {
    if (active) {
        stopAudioSave();
        return;
    }

    // Immediate feedback while waiting for mic permission
    _btnEl.textContent = 'Requesting mic\u2026';
    _btnEl.classList.add('active');

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        _btnEl.textContent = 'Hands-Free Audio Save';
        _btnEl.classList.remove('active');
        console.warn('Microphone access denied:', err);
        showToast('Microphone access denied');
        return;
    }

    context  = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 256;

    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    active = true;
    _btnEl.textContent = 'Listening\u2026';
    _controlsEl.style.display = '';
    showToast('Audio save active — clap or speak to capture');
    _monitor();
}

/** Stop monitoring and tear down the audio graph. */
export function stopAudioSave() {
    active = false;
    _btnEl.classList.remove('active');
    _btnEl.textContent = 'Hands-Free Audio Save';
    _controlsEl.style.display = 'none';
    _meterEl.style.width = '0%';
    showToast('Audio save stopped');

    if (context) {
        context.close();
        context  = null;
        analyser = null;
    }
}

/* ── Internal rAF loop ──────────────────────────────────────────────── */

function _monitor() {
    if (!active || !analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
    }
    const rms   = Math.sqrt(sum / data.length);
    const level = Math.min(100, Math.round(rms * 300));

    _meterEl.style.width = level + '%';

    if (level >= sensitivity && !cooldown) {
        if (_onSave) _onSave();
        cooldown = true;
        _meterEl.style.background = '#43A047';
        setTimeout(() => {
            cooldown = false;
            _meterEl.style.background = '';
        }, 1500);
    }

    requestAnimationFrame(_monitor);
}
