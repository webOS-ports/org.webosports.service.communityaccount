// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	terms.js: the account server's terms of service, from the HTML
	getTermsAndConditions answers ({"PALM": "<h2>...</h2><p>...</p>"}) to plain
	text: headings and paragraphs on lines of their own, entities decoded,
	every tag gone.

	What a caller shows is text, never the server's HTML: rich text in QML or
	a web view would fetch any image the HTML names, telling a third party
	when the screen was opened, and would follow its links.
*/

const MAX_HTML = 256 * 1024;
const MAX_TEXT = 64 * 1024;

const NAMED = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
	mdash: '—', ndash: '–', hellip: '…',
	lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
	copy: '©', reg: '®', trade: '™', middot: '·', bull: '•'
};

function decodeEntities(text) {
	return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, name) => {
		if (name[0] === '#') {
			const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			// No control characters, surrogates or what is past Unicode.
			if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f ||
				(code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
				return '';
			}
			return String.fromCodePoint(code);
		}
		return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : whole;
	});
}

function termsText(html) {
	let s = String(html || '').slice(0, MAX_HTML);
	// Nothing inside these is text.
	s = s.replace(/<(script|style|head|title)\b[^]*?<\/\1\s*>/gi, '');
	s = s.replace(/<!--[^]*?-->/g, '');
	// Block ends and breaks become line ends; every other tag goes.
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<\/?(p|h[1-6]|li|ul|ol|div|tr|table|blockquote)\b[^>]*>/gi, '\n\n');
	s = s.replace(/<[^>]*>/g, '');
	s = s.replace(/<[^]*$/, '');
	s = decodeEntities(s);
	// What is left of control characters (a raw one in the HTML), out.
	s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
	s = s.replace(/[ \t ]+/g, ' ');
	s = s.split('\n').map(line => line.trim()).join('\n');
	s = s.replace(/\n{3,}/g, '\n\n').trim();
	return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

module.exports = {termsText};
