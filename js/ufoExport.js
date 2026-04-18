/**
 * ufoExport.js — UFO (Unified Font Object) export
 * Exports glyphs as a .ufo package (zipped) that Fontra and other
 * font editors can open and edit. Reuses the stroke expansion pipeline
 * from fontExport.js, converting opentype.Path commands to GLIF XML.
 *
 * Requires JSZip global from CDN.
 */

import { shapesToPath } from './fontExport.js';

/* ── Plist XML helpers ───────────────────────────────────────── */

function plistHeader() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;
}

function plistValue(val) {
    if (typeof val === 'string') return `\t<string>${escXml(val)}</string>`;
    if (typeof val === 'number') {
        return Number.isInteger(val) ? `\t<integer>${val}</integer>` : `\t<real>${val}</real>`;
    }
    if (typeof val === 'boolean') return val ? '\t<true/>' : '\t<false/>';
    return `\t<string>${String(val)}</string>`;
}

function plistDict(entries, indent = '') {
    let xml = `${indent}<dict>\n`;
    for (const [key, val] of entries) {
        xml += `${indent}\t<key>${escXml(key)}</key>\n`;
        if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
            xml += plistDict(Object.entries(val), indent + '\t') + '\n';
        } else {
            xml += `${indent}${plistValue(val)}\n`;
        }
    }
    xml += `${indent}</dict>`;
    return xml;
}

function escXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/* ── Glyph name (AGL → PostScript) ───────────────────────────── */

const AGL = {
    ' ':'space','!':'exclam','"':'quotedbl','#':'numbersign','$':'dollar',
    '%':'percent','&':'ampersand',"'":'quotesingle','(':'parenleft',')':'parenright',
    '*':'asterisk','+':'plus',',':'comma','-':'hyphen','.':'period','/':'slash',
    ':':'colon',';':'semicolon','<':'less','=':'equal','>':'greater','?':'question',
    '@':'at','[':'bracketleft','\\':'backslash',']':'bracketright','^':'asciicircum',
    '_':'underscore','`':'grave','{':'braceleft','|':'bar','}':'braceright','~':'asciitilde',
    '\u00A0':'nbspace','\u00A1':'exclamdown','\u00A2':'cent','\u00A3':'sterling',
    '\u00A5':'yen','\u00A7':'section','\u00A9':'copyright','\u00AB':'guillemotleft',
    '\u00AE':'registered','\u00B0':'degree','\u00B1':'plusminus','\u00B7':'periodcentered',
    '\u00BB':'guillemotright','\u00BF':'questiondown',
    '\u00C0':'Agrave','\u00C1':'Aacute','\u00C2':'Acircumflex','\u00C3':'Atilde',
    '\u00C4':'Adieresis','\u00C5':'Aring','\u00C6':'AE','\u00C7':'Ccedilla',
    '\u00C8':'Egrave','\u00C9':'Eacute','\u00CA':'Ecircumflex','\u00CB':'Edieresis',
    '\u00CC':'Igrave','\u00CD':'Iacute','\u00CE':'Icircumflex','\u00CF':'Idieresis',
    '\u00D1':'Ntilde','\u00D2':'Ograve','\u00D3':'Oacute','\u00D4':'Ocircumflex',
    '\u00D5':'Otilde','\u00D6':'Odieresis','\u00D8':'Oslash','\u00D9':'Ugrave',
    '\u00DA':'Uacute','\u00DB':'Ucircumflex','\u00DC':'Udieresis','\u00DF':'germandbls',
    '\u00E0':'agrave','\u00E1':'aacute','\u00E2':'acircumflex','\u00E3':'atilde',
    '\u00E4':'adieresis','\u00E5':'aring','\u00E6':'ae','\u00E7':'ccedilla',
    '\u00E8':'egrave','\u00E9':'eacute','\u00EA':'ecircumflex','\u00EB':'edieresis',
    '\u00EC':'igrave','\u00ED':'iacute','\u00EE':'icircumflex','\u00EF':'idieresis',
    '\u00F1':'ntilde','\u00F2':'ograve','\u00F3':'oacute','\u00F4':'ocircumflex',
    '\u00F5':'otilde','\u00F6':'odieresis','\u00F8':'oslash','\u00F9':'ugrave',
    '\u00FA':'uacute','\u00FB':'ucircumflex','\u00FC':'udieresis',
    '\u2013':'endash','\u2014':'emdash','\u2018':'quoteleft','\u2019':'quoteright',
    '\u201A':'quotesinglbase','\u201C':'quotedblleft','\u201D':'quotedblright',
    '\u201E':'quotedblbase','\u2020':'dagger','\u2021':'daggerdbl','\u2022':'bullet',
    '\u2026':'ellipsis','\u2030':'perthousand','\u2039':'guilsinglleft','\u203A':'guilsinglright',
    '\u20AC':'Euro',
};

/** Convert a single char to a PostScript-safe glyph name. */
function charToGlyphName(ch) {
    if (ch === '.notdef') return '.notdef';
    if (AGL[ch]) return AGL[ch];
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(ch)) return ch;
    const cp = ch.codePointAt(0);
    if (cp <= 0xFFFF) return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0');
    return 'u' + cp.toString(16).toUpperCase().padStart(5, '0');
}

/* ── Plist file generators ───────────────────────────────────── */

function generateMetainfo() {
    return `${plistHeader()}
${plistDict([
    ['creator', 'org.bodytext.ufoExport'],
    ['formatVersion', 3],
])}
</plist>`;
}

function generateFontinfo(metrics, fontFamily) {
    const ascender  = metrics?.ascender  ?? 800;
    const descender = metrics?.descender ?? 200;

    const entries = [
        ['familyName', fontFamily],
        ['unitsPerEm', 1000],
        ['ascender', ascender],
        ['descender', -descender],
    ];
    if (metrics?.xHeight != null)  entries.push(['xHeight', metrics.xHeight]);
    if (metrics?.capHeight != null) entries.push(['capHeight', metrics.capHeight]);

    return `${plistHeader()}
${plistDict(entries)}
</plist>`;
}

function generateContentsPlist(glyphMap) {
    let xml = `${plistHeader()}\n<dict>\n`;
    for (const [glyphName, fileName] of glyphMap) {
        xml += `\t<key>${escXml(glyphName)}</key>\n`;
        xml += `\t<string>${escXml(fileName)}</string>\n`;
    }
    xml += `</dict>\n</plist>`;
    return xml;
}

function generateLayerContents() {
    return `${plistHeader()}
<array>
\t<array>
\t\t<string>public.default</string>
\t\t<string>glyphs</string>
\t</array>
</array>
</plist>`;
}

function generateLib() {
    return `${plistHeader()}
<dict>
\t<key>public.glyphOrder</key>
\t<array/>
</dict>
</plist>`;
}

/* ── UFO glyph filename convention ───────────────────────────── */

/**
 * UFO 3 user-name-to-file-name algorithm.
 * https://unifiedfontobject.org/versions/ufo3/conventions/#user-name-to-file-name
 *
 * - Illegal filesystem chars → "_"
 * - Uppercase letters → append "_" to handle case-insensitive filesystems
 * - Reserved Windows device names → prefix "_"
 * - Leading "." → prefix "_"
 * - Truncate to 255 bytes
 * - Collisions resolved by caller via `existing` set
 */
const UFO_ILLEGAL = new Set('"*+/:<>?[\\]|'.split(''));
const UFO_RESERVED = new Set([
    'CON','PRN','AUX','NUL','CLOCK$',
    'COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
    'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
]);

function glyphNameToFilename(name, existing) {
    let out = '';
    for (const ch of name) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7F || UFO_ILLEGAL.has(ch)) {
            out += '_';
        } else if (ch >= 'A' && ch <= 'Z') {
            out += ch + '_';
        } else {
            out += ch;
        }
    }
    if (!out) out = '_';
    if (out.startsWith('.')) out = '_' + out.slice(1);
    const base = out.split('.')[0].toUpperCase();
    if (UFO_RESERVED.has(base)) out = '_' + out;
    if (out.length > 250) out = out.slice(0, 250);

    let candidate = out + '.glif';
    let n = 1;
    while (existing && existing.has(candidate.toLowerCase())) {
        candidate = `${out}_${String(n).padStart(15, '0')}.glif`;
        n++;
    }
    if (existing) existing.add(candidate.toLowerCase());
    return candidate;
}

/* ── opentype.Path → GLIF XML contours ───────────────────────── */

/**
 * Convert an opentype.js Path's commands into GLIF <outline> XML.
 *
 * opentype.Path commands: { type: 'M'|'L'|'C'|'Q'|'Z', x, y, x1, y1, x2, y2 }
 * GLIF contour points: <point x="" y="" type="line|curve" [smooth="yes"]/>
 *
 * Strategy: split on 'M' to get contours. For each closed contour,
 * the moveTo point becomes the first on-curve point with type="line"
 * (since closePath returns to it via an implicit straight segment).
 */
function pathToGlifOutline(opentypePath) {
    const cmds = opentypePath.commands;
    if (!cmds || cmds.length === 0) return '  <outline/>';

    // Split commands into contours (each starts with M, ends with Z)
    const contours = [];
    let current = null;

    for (const cmd of cmds) {
        if (cmd.type === 'M') {
            current = [cmd];
        } else if (current) {
            current.push(cmd);
            if (cmd.type === 'Z') {
                contours.push(current);
                current = null;
            }
        }
    }

    if (contours.length === 0) return '  <outline/>';

    let xml = '  <outline>\n';

    for (const contour of contours) {
        const moveTo = contour[0]; // type 'M'
        const points = [];

        // Collect points from commands after moveTo (before closePath)
        for (let i = 1; i < contour.length; i++) {
            const cmd = contour[i];
            if (cmd.type === 'L') {
                points.push({ x: cmd.x, y: cmd.y, type: 'line' });
            } else if (cmd.type === 'C') {
                points.push({ x: cmd.x1, y: cmd.y1 }); // off-curve
                points.push({ x: cmd.x2, y: cmd.y2 }); // off-curve
                points.push({ x: cmd.x, y: cmd.y, type: 'curve' });
            }
            // 'Z' handled by loop termination
        }

        if (points.length === 0) continue;

        // Determine the type for the moveTo point: it gets the type of the
        // segment arriving at it (the last segment, wrapping around).
        // If the last point is an on-curve ending a line → moveTo is "line"
        // If the last point is an on-curve ending a curve → check if the
        // segment from last on-curve to moveTo is a curve
        // In practice: closePath draws a line back, so moveTo gets "line".
        const moveType = 'line';

        xml += '    <contour>\n';
        xml += `      <point x="${r(moveTo.x)}" y="${r(moveTo.y)}" type="${moveType}"/>\n`;
        for (const pt of points) {
            if (pt.type) {
                xml += `      <point x="${r(pt.x)}" y="${r(pt.y)}" type="${pt.type}"/>\n`;
            } else {
                xml += `      <point x="${r(pt.x)}" y="${r(pt.y)}"/>\n`;
            }
        }
        xml += '    </contour>\n';
    }

    xml += '  </outline>';
    return xml;
}

/** Round to integer for clean UFO coordinates. */
function r(v) { return Math.round(v); }

/* ── GLIF file generator ─────────────────────────────────────── */

function generateGlif(glyphName, unicodeVal, advanceWidth, opentypePath) {
    const hexUni = unicodeVal != null
        ? `  <unicode hex="${unicodeVal.toString(16).toUpperCase().padStart(4, '0').toUpperCase()}"/>\n`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<glyph name="${escXml(glyphName)}" format="2">
  <advance width="${Math.round(advanceWidth)}"/>
${hexUni}${pathToGlifOutline(opentypePath)}
</glyph>`;
}

/* ── Main export ─────────────────────────────────────────────── */

/**
 * Export all stored letters as a .ufo package (zipped for download).
 *
 * @param {import('./letterStore.js').LetterStore} letterStore
 * @param {object} [metrics] — guideState with ascender, descender, etc.
 * @param {string} [fontFamily='bodyText']
 */
export async function exportUFO(letterStore, metrics, fontFamily = 'bodyText') {
    if (typeof JSZip === 'undefined') {
        console.error('JSZip not loaded — cannot export UFO');
        return;
    }

    const unitsPerEm = 1000;
    const zip = new JSZip();
    const root = zip.folder(`${fontFamily}.ufo`);
    const glyphsDir = root.folder('glyphs');

    // ── Plist metadata ──
    root.file('metainfo.plist', generateMetainfo());
    root.file('fontinfo.plist', generateFontinfo(metrics, fontFamily));
    root.file('lib.plist', generateLib());
    root.file('layercontents.plist', generateLayerContents());

    // ── Glyphs ──
    const glyphMap = []; // [glyphName, filename] pairs for contents.plist
    const usedFilenames = new Set();

    // .notdef glyph
    const ascender = metrics?.ascender ?? 800;
    const notdefPath = new opentype.Path();
    notdefPath.moveTo(100, 0);
    notdefPath.lineTo(100, ascender);
    notdefPath.lineTo(500, ascender);
    notdefPath.lineTo(500, 0);
    notdefPath.closePath();
    const notdefFile = glyphNameToFilename('.notdef', usedFilenames);
    glyphsDir.file(notdefFile, generateGlif('.notdef', null, 650, notdefPath));
    glyphMap.push(['.notdef', notdefFile]);

    // Letter glyphs
    for (const char of letterStore.getStoredChars()) {
        const data = letterStore.getLetter(char);
        if (!data?.shapes?.length) continue;

        const bL = (data.bearingLeft ?? metrics?.bearingLeft ?? 10) / 100;
        const bR = (data.bearingRight ?? metrics?.bearingRight ?? 10) / 100;
        const xShift = -bL * unitsPerEm;
        const advanceWidth = Math.round((1 - bL - bR) * unitsPerEm);

        const path = shapesToPath(
            data.shapes, unitsPerEm,
            data.deformedSnapshot,
            data.joinFlags,
            data.bindings,
            xShift,
        );

        const glyphName = charToGlyphName(char);
        const fileName = glyphNameToFilename(glyphName, usedFilenames);
        const unicode = char.codePointAt(0);

        glyphsDir.file(fileName, generateGlif(glyphName, unicode, advanceWidth, path));
        glyphMap.push([glyphName, fileName]);
    }

    glyphsDir.file('contents.plist', generateContentsPlist(glyphMap));

    // ── Download ──
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fontFamily}.ufo.zip`;
    a.click();
    URL.revokeObjectURL(url);
}
