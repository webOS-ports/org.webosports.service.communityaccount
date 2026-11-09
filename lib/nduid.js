// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	nduid.js: the platform's id for this device, the same one woce-backup
	names its manifests after (com.palm.app.backup.service util/system.js),
	tried in the same order:

	1. /dev/nduid, legacy webOS's character device. fs.readFile stats it,
	   sees size 0 and returns "" having read nothing; openSync/readSync is
	   what works. LuneOS has no such device.
	2. nyx-cmd DeviceInfo query nduid. On Halium nyx-modules-hybris makes it
	   SHA1(ro.serialno); on mainline (PinePhone, PinePhone Pro, PineTab2)
	   nyx-modules makes a random one once and keeps it in /var/lib/nyx/nduid.
	   Run with execFile, no shell, and the output checked: a query a platform
	   does not implement prints an error, not an id.
	3. "Unknown".

	This is not what the account server sees: deviceid.js derives that from it
	with a secret only this device has.
*/

const fs = require('fs');
const childProcess = require('child_process');

const UNKNOWN = 'Unknown';
const NDUID_PATH = '/dev/nduid';
const NYX_CMD = 'nyx-cmd';
const NYX_TIMEOUT_MS = 10000;

// An id is letters and digits, of a sensible length: a manifest name and a
// request field are built from it, so no '/', whitespace or error text.
const VALID = /^[0-9A-Za-z]{8,128}$/;

function valid(text) {
	const id = String(text || '').trim();
	return VALID.test(id) ? id : null;
}

function fromDevice(path) {
	let fd = -1;
	try {
		fd = fs.openSync(path, 'r');
		const buf = Buffer.alloc(256);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		return valid(buf.toString('utf8', 0, n));
	} finally {
		if (fd >= 0) {
			try {
				fs.closeSync(fd);
			} catch (e) { /* already gone */ }
		}
	}
}

function fromNyx(execFileSync) {
	const out = execFileSync(NYX_CMD, ['DeviceInfo', 'query', 'nduid'], {
		encoding: 'utf8',
		timeout: NYX_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'ignore'],
		maxBuffer: 4096
	});
	// The id on a line of its own; nothing else counts.
	return valid(String(out).split('\n')[0]);
}

function readNduid({path = NDUID_PATH, execFileSync = childProcess.execFileSync, log = console} = {}) {
	try {
		const id = fromDevice(path);
		if (id) {
			return id;
		}
	} catch (e) {
		if (e && e.code !== 'ENOENT') {
			log.warn && log.warn('nduid: could not read ' + path + ': ' + e.message);
		}
	}
	try {
		const id = fromNyx(execFileSync);
		if (id) {
			return id;
		}
		log.warn && log.warn('nduid: nyx-cmd gave no usable nduid');
	} catch (e) {
		log.warn && log.warn('nduid: nyx-cmd failed: ' + (e && e.message || e));
	}
	log.warn && log.warn('nduid: none found, using ' + UNKNOWN);
	return UNKNOWN;
}

module.exports = {readNduid, UNKNOWN, NDUID_PATH, VALID};
