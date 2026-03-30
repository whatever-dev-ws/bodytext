/**
 * toast.js — Lightweight toast notification system
 * Shows brief, non-blocking notifications at the bottom of the viewport.
 */

const container = document.getElementById('toast-container');

/**
 * Show a toast notification.
 * @param {string} message — text to display
 * @param {number} [duration=2000] — milliseconds before auto-dismiss
 */
export function showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    // Double-rAF ensures the element is in the DOM before triggering transition
    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('toast--visible'));
    });
    setTimeout(() => {
        toast.classList.remove('toast--visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, duration);
}
