// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	nduid.js: the device's unique id, which names a manifest (NNNNNN-<nduId>)
	so backups from different devices never collide on one shared target.

	It comes from /dev/nduid, a character device. fs.readFile stats it, sees
	size 0, and returns "" having read nothing (woce-backup learned this on
	device); openSync/readSync is the only thing that works.
*/

const fs = require('fs');

const UNKNOWN = 'Unknown';
const NDUID_PATH = '/dev/nduid';

function readNduid({path = NDUID_PATH, log = console} = {}) {
	let fd = -1;
	try {
		fd = fs.openSync(path, 'r');
		const buf = Buffer.alloc(256);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const id = buf.toString('utf8', 0, n).trim();
		// Keep only what a manifest name allows; never let a stray byte put a
		// '/' or whitespace into a path component.
		const clean = id.replace(/[^0-9A-Za-z]/g, '');
		return clean || UNKNOWN;
	} catch (e) {
		log.warn && log.warn('nduid: could not read ' + path + ': ' + e.message + ', using ' + UNKNOWN);
		return UNKNOWN;
	} finally {
		if (fd >= 0) {
			try {
				fs.closeSync(fd);
			} catch (e) { /* already gone */ }
		}
	}
}

module.exports = {readNduid, UNKNOWN, NDUID_PATH};
