/**
 * letterStore.js — In-memory letter storage
 * Stores per-character glyph data (shapes, bindings, stroke width).
 * Supports JSON export/import for sharing designs across computers.
 */

export class LetterStore {
    constructor() {
        /** @type {Map<string, {shapes: Array, bindings: Object, strokeWidth: number}>} */
        this.letters = new Map();
    }

    /**
     * Save a letter's complete parameters.
     * @param {string} char — single character key (e.g. 'A', 'a', '0')
     * @param {Object} data — { shapes, bindings, strokeWidth }
     */
    saveLetter(char, data) {
        this.letters.set(char, JSON.parse(JSON.stringify(data)));
    }

    /**
     * Retrieve stored parameters for a character, or null.
     */
    getLetter(char) {
        const data = this.letters.get(char);
        return data ? JSON.parse(JSON.stringify(data)) : null;
    }

    /**
     * Check if a character has been designed.
     */
    hasLetter(char) {
        return this.letters.has(char);
    }

    /**
     * List all stored character keys.
     */
    getStoredChars() {
        return [...this.letters.keys()].sort();
    }

    /**
     * Delete a stored letter.
     */
    deleteLetter(char) {
        this.letters.delete(char);
    }

    /**
     * Export all letters + project settings as a JSON file download.
     * @param {object} [guideState] — current guide metrics to include
     */
    exportJSON(guideState) {
        const letters = {};
        for (const [char, letterData] of this.letters) {
            letters[char] = letterData;
        }

        const project = {
            version: 2,
            guides: guideState ? {
                baseline:     guideState.baseline,
                ascender:     guideState.ascender,
                capHeight:    guideState.capHeight,
                xHeight:      guideState.xHeight,
                descender:    guideState.descender,
                bearingLeft:  guideState.bearingLeft,
                bearingRight: guideState.bearingRight,
            } : undefined,
            letters,
        };

        const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'bodytext-project.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Import project from a JSON file.
     * @param {File} file — File object from an <input type="file">
     * @returns {Promise<{count: number, guides: object|null}>}
     */
    async importJSON(file) {
        const text = await file.text();
        const data = JSON.parse(text);
        let count = 0;
        const guides = data.guides || null;
        for (const [char, letterData] of Object.entries(data.letters || {})) {
            this.letters.set(char, letterData);
            count++;
        }
        return { count, guides };
    }
}
