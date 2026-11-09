// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	deviceid.js: the id the webOS Community Account server knows this device
	by, in place of the platform nduId.

	The platform nduId is not fit to hand to a third party. On Halium it is
	SHA1(ro.serialno), unsalted: the serial is printed on the box and shown by
	adb, so anyone who has it can compute the id and find the device and its
	account. So the server gets

	    HMAC-SHA1(key, "org.webosports.service.communityaccount/device-id\0" + nduId)

	as 40 hex characters - the shape it has always had - where key is 32
	random bytes made on this device the first time and kept in
	/var/lib/org.webosports.service.communityaccount/device-id.key (0600, in a
	0700 directory). Nobody without the key can compute it from the serial or
	the nduId, the same nduId gives a different id on another key, and even a
	device with no nduId ("Unknown") gets one of its own.

	It is stable across reboots and updates; a data wipe makes a new key and
	so a new id, which the server then sees as a new device - as mainline's
	random nduId already does. The platform nduId itself is unchanged and stays
	on the device (woce-backup names its manifests after it).

	The key file is read without following a symlink and must be a regular
	file of exactly 32 bytes. One of another size is replaced (and the id with
	it); a symlink or anything else that is not a regular file is refused, and
	so is a directory that is not this process's own.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {CloudError} = require('./errors');

const DIR = '/var/lib/org.webosports.service.communityaccount';
const KEY_FILE = 'device-id.key';
const KEY_BYTES = 32;
const CONTEXT = 'org.webosports.service.communityaccount/device-id\0';

function unavailable(why) {
	return new CloudError('DEVICE_ID_UNAVAILABLE', 'no device id: ' + why);
}

function ensureDir(dir) {
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	const st = fs.lstatSync(dir);
	if (!st.isDirectory()) {
		throw unavailable(dir + ' is not a directory');
	}
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
		throw unavailable(dir + ' is not ours');
	}
	if ((st.mode & 0o077) !== 0) {
		fs.chmodSync(dir, 0o700);
	}
}

// The key, or null when there is no usable one (missing, or the wrong size).
function readKey(file) {
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (e) {
		if (e.code === 'ENOENT') {
			return null;
		}
		if (e.code === 'ELOOP') {
			throw unavailable(file + ' is a symlink');
		}
		throw unavailable('could not open ' + file + ': ' + e.code);
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) {
			throw unavailable(file + ' is not a regular file');
		}
		if (st.size !== KEY_BYTES) {
			return null;
		}
		const key = Buffer.alloc(KEY_BYTES);
		const n = fs.readSync(fd, key, 0, KEY_BYTES, 0);
		return n === KEY_BYTES ? key : null;
	} finally {
		fs.closeSync(fd);
	}
}

// A new key, written whole into a new file and renamed over file.
function writeKey(file, randomBytes) {
	const key = randomBytes(KEY_BYTES);
	const temp = file + '.tmp-' + randomBytes(9).toString('hex');
	const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
		fs.constants.O_NOFOLLOW, 0o600);
	try {
		try {
			fs.writeSync(fd, key, 0, KEY_BYTES);
			fs.fchmodSync(fd, 0o600);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, file);
	} catch (e) {
		try {
			fs.unlinkSync(temp);
		} catch (ignored) { /* already gone */ }
		throw e;
	}
	return key;
}

function createDeviceIdentity({dir = DIR, randomBytes = crypto.randomBytes, log = console} = {}) {
	let key = null;

	function loadKey() {
		if (key) {
			return key;
		}
		const file = path.join(dir, KEY_FILE);
		try {
			ensureDir(dir);
			key = readKey(file);
			if (!key) {
				log.log && log.log('deviceid: making a new device key');
				key = writeKey(file, randomBytes);
			}
		} catch (e) {
			if (e instanceof CloudError) {
				throw e;
			}
			throw unavailable(e.code || e.message);
		}
		return key;
	}

	// What the account server knows this device by.
	function accountId(nduId) {
		return crypto.createHmac('sha1', loadKey()).update(CONTEXT + String(nduId)).digest('hex');
	}

	return {accountId};
}

module.exports = {createDeviceIdentity, DIR, KEY_FILE, KEY_BYTES};
