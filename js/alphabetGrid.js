/**
 * alphabetGrid.js — Self-populating alphabet grid UI with shape previews.
 *
 * Renders a grid of character cells organised by section.
 * Designed letters show a canvas-rendered preview of their shapes
 * (using the deformed snapshot from save time) instead of system font text.
 */

import { computeSplineSegments, DEFAULT_TANGENCY } from './shapes.js';

const SECTIONS = [
    { label: 'Uppercase',    chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { label: 'Lowercase',    chars: 'abcdefghijklmnopqrstuvwxyz' },
    { label: 'Digits',       chars: '0123456789' },
    { label: 'Accented',     chars: 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ' },
    { label: 'Punctuation',  chars: '.,:;!?…·\u2018\u2019\u201C\u201D\'"-\u2013\u2014()[]{}/@#&*+=' },
];

const ALL_CHARS = SECTIONS.flatMap(s => [...s.chars]);

/** Shared off-screen canvas for generating cell preview images. */
const _offscreen = document.createElement('canvas');
const _offCtx    = _offscreen.getContext('2d');
const PREVIEW_PX = 64;  // render at 2× for retina, display at 32px
_offscreen.width  = PREVIEW_PX;
_offscreen.height = PREVIEW_PX;

/**
 * Render shape preview onto the off-screen canvas.
 * Returns a data URL, or null if there's nothing to draw.
 */
function renderPreview(shapes, deformedSnapshot) {
    const w = PREVIEW_PX;
    const h = PREVIEW_PX;
    _offCtx.clearRect(0, 0, w, h);

    if (!shapes?.length) return null;

    _offCtx.save();
    _offCtx.strokeStyle = '#222';
    _offCtx.fillStyle   = '#222';

    for (const shape of shapes) {
        const pts = shape.points.map((p, i) => {
            const override = deformedSnapshot?.[shape.id]?.[i];
            return {
                x: (override ? override.x : p.x) * w,
                y: (override ? override.y : p.y) * h,
            };
        });

        // Scale stroke for the small preview
        const sw = Math.max(1.5, (shape.strokeWidth / 500) * w);
        _offCtx.lineWidth = sw;
        _offCtx.lineCap   = shape.lineCap  || 'round';
        _offCtx.lineJoin  = shape.lineJoin || 'round';

        if (shape.type === 'dot' && pts.length >= 1) {
            _offCtx.beginPath();
            _offCtx.arc(pts[0].x, pts[0].y, Math.max(1, sw / 2), 0, Math.PI * 2);
            _offCtx.fill();
        } else if (shape.type === 'polyline' && pts.length >= 2) {
            _offCtx.beginPath();
            _offCtx.moveTo(pts[0].x, pts[0].y);
            for (let j = 1; j < pts.length; j++) _offCtx.lineTo(pts[j].x, pts[j].y);
            if (shape.closed) _offCtx.closePath();
            _offCtx.stroke();
        } else if (shape.type === 'arc' && pts.length >= 2) {
            _offCtx.beginPath();
            _offCtx.moveTo(pts[0].x, pts[0].y);
            if (pts.length === 2 && !shape.closed) {
                _offCtx.lineTo(pts[1].x, pts[1].y);
            } else {
                const tension = shape.tangency ?? DEFAULT_TANGENCY;
                const segs = computeSplineSegments(pts, tension, shape.closed);
                for (const s of segs) {
                    _offCtx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.ex, s.ey);
                }
            }
            _offCtx.stroke();
        }
    }

    _offCtx.restore();
    return _offscreen.toDataURL();
}

export function buildAlphabetGrid(containerEl, onSelect) {
    containerEl.innerHTML = '';

    for (const section of SECTIONS) {
        const label = document.createElement('span');
        label.className = 'alphabet-section-label';
        label.textContent = section.label;
        containerEl.appendChild(label);

        const group = document.createElement('div');
        group.className = 'alphabet-section';

        for (const char of section.chars) {
            const cell = document.createElement('button');
            cell.className = 'alphabet-cell';
            cell.dataset.char = char;

            // Text fallback (shown when no preview)
            const txt = document.createElement('span');
            txt.className = 'cell-text';
            txt.textContent = char;
            cell.appendChild(txt);

            // Preview image (hidden until a preview is set)
            const img = document.createElement('img');
            img.className = 'cell-preview';
            img.style.display = 'none';
            cell.appendChild(img);

            cell.addEventListener('click', () => onSelect(char));
            group.appendChild(cell);
        }

        containerEl.appendChild(group);
    }
}

export function updateAlphabetGrid(containerEl, letterStore, currentLetter) {
    const cells  = containerEl.querySelectorAll('.alphabet-cell');
    const stored = letterStore ? letterStore.getStoredChars() : [];

    let i = 0;
    for (const cell of cells) {
        const char = ALL_CHARS[i];
        const isDesigned = stored.includes(char);

        cell.classList.toggle('designed', isDesigned);
        cell.classList.toggle('current',  char === currentLetter);

        const txt = cell.querySelector('.cell-text');
        const img = cell.querySelector('.cell-preview');

        if (isDesigned && letterStore) {
            const data = letterStore.getLetter(char);
            if (data?.shapes?.length) {
                const dataURL = renderPreview(data.shapes, data.deformedSnapshot);
                if (dataURL) {
                    img.src = dataURL;
                    img.style.display = '';
                    txt.style.display = 'none';
                } else {
                    img.style.display = 'none';
                    txt.style.display = '';
                }
            } else {
                img.style.display = 'none';
                txt.style.display = '';
            }
        } else {
            img.style.display = 'none';
            txt.style.display = '';
        }

        i++;
    }
}
