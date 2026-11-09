// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	The platform nduId (nduid.js) and the account device id made from it
	(deviceid.js): where the nduId comes from on each kind of device, and that
	what the server sees cannot be worked out from the serial or the nduId.
*/

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {readNduid, UNKNOWN} = require('../lib/nduid');
const {createDeviceIdentity, KEY_FILE, KEY_BYTES} = require('../lib/deviceid');
const {createDevice} = require('../lib/device');
const {quietLog, fakePc} = require('./helpers');

function tempDir(t) {
	const base = process.env.TMPDIR || os.tmpdir();
	const dir = fs.mkdtempSync(path.join(base, 'communityaccount-'));
	t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
	return dir;
}

const SARGO_NDUID = '3aa909f588ed74feb8a41d7b8830f1b2321937bf';
const nyxSays = text => (cmd, args) => {
	assert.strictEqual(cmd, 'nyx-cmd');
	assert.deepStrictEqual(args, ['DeviceInfo', 'query', 'nduid']);
	return text;
};
const nyxFails = () => {
	throw new Error('spawnSync nyx-cmd ENOENT');
};

/* ---- nduid.js ---- */

test('nduid: /dev/nduid first, as on legacy webOS', t => {
	const dev = path.join(tempDir(t), 'nduid');
	fs.writeFileSync(dev, 'abcdef0123456789\n');
	assert.strictEqual(readNduid({path: dev, execFileSync: nyxFails, log: quietLog}), 'abcdef0123456789');
});

test('nduid: without /dev/nduid, what nyx says (Halium and mainline)', t => {
	const dev = path.join(tempDir(t), 'nduid');
	assert.strictEqual(readNduid({path: dev, execFileSync: nyxSays(SARGO_NDUID + '\n'), log: quietLog}), SARGO_NDUID);
});

test('nduid: a /dev/nduid with nothing usable in it falls back to nyx', t => {
	const dev = path.join(tempDir(t), 'nduid');
	fs.writeFileSync(dev, '');
	assert.strictEqual(readNduid({path: dev, execFileSync: nyxSays(SARGO_NDUID), log: quietLog}), SARGO_NDUID);
	fs.writeFileSync(dev, '../../etc/passwd');
	assert.strictEqual(readNduid({path: dev, execFileSync: nyxSays(SARGO_NDUID), log: quietLog}), SARGO_NDUID);
});

test('nduid: what nyx prints that is not an id is not taken', t => {
	const dev = path.join(tempDir(t), 'nduid');
	for (const out of ['', 'Error: Query not implemented', 'not supported', 'short', 'abc/def0123456', 'x'.repeat(200),
		'id with spaces in it', '\n' + SARGO_NDUID]) {
		assert.strictEqual(readNduid({path: dev, execFileSync: nyxSays(out), log: quietLog}), UNKNOWN, JSON.stringify(out));
	}
});

test('nduid: no nyx-cmd at all gives Unknown', t => {
	const dev = path.join(tempDir(t), 'nduid');
	assert.strictEqual(readNduid({path: dev, execFileSync: nyxFails, log: quietLog}), UNKNOWN);
});

test('nduid: nyx-cmd is run without a shell, with a time limit', t => {
	const dev = path.join(tempDir(t), 'nduid');
	let options = null;
	readNduid({path: dev, log: quietLog, execFileSync: (cmd, args, opts) => {
		options = opts;
		return SARGO_NDUID;
	}});
	assert.ok(options && !options.shell, 'run through a shell');
	assert.ok(options.timeout > 0 && options.timeout <= 30000);
});

/* ---- deviceid.js ---- */

test('device id: 40 hex characters, and not the nduId or anything plainly made from it or the serial', t => {
	const id = createDeviceIdentity({dir: tempDir(t), log: quietLog}).accountId(SARGO_NDUID);
	assert.match(id, /^[0-9a-f]{40}$/);
	assert.notStrictEqual(id, SARGO_NDUID);
	const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
	// Sargo's nduId is SHA1 of its serial: none of these may be what the server gets.
	for (const guess of [sha1('05DAY1XC8P'), sha1(SARGO_NDUID), sha1('Unknown')]) {
		assert.notStrictEqual(id, guess);
	}
});

test('device id: the same on every call and after a restart, from the key kept on the device', t => {
	const dir = tempDir(t);
	const a = createDeviceIdentity({dir, log: quietLog}).accountId(SARGO_NDUID);
	const b = createDeviceIdentity({dir, log: quietLog});
	assert.strictEqual(b.accountId(SARGO_NDUID), a);
	assert.strictEqual(b.accountId(SARGO_NDUID), a);
	const st = fs.statSync(path.join(dir, KEY_FILE));
	assert.strictEqual(st.size, KEY_BYTES);
	assert.strictEqual(st.mode & 0o777, 0o600);
	assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
	// Nothing but the key is left in the directory.
	assert.deepStrictEqual(fs.readdirSync(dir), [KEY_FILE]);
});

test('device id: another device (another key) gets another id for the same nduId', t => {
	const a = createDeviceIdentity({dir: tempDir(t), log: quietLog}).accountId(UNKNOWN);
	const b = createDeviceIdentity({dir: tempDir(t), log: quietLog}).accountId(UNKNOWN);
	assert.notStrictEqual(a, b, 'two devices with no nduId share an id');
});

test('device id: it is the HMAC of the nduId under the key, nothing weaker', t => {
	const dir = tempDir(t);
	const key = Buffer.alloc(KEY_BYTES, 7);
	const id = createDeviceIdentity({dir, log: quietLog, randomBytes: n => Buffer.alloc(n, 7)}).accountId(SARGO_NDUID);
	const expected = crypto.createHmac('sha1', key)
		.update('org.webosports.service.communityaccount/device-id\0' + SARGO_NDUID).digest('hex');
	assert.strictEqual(id, expected);
});

test('device id: a key file of the wrong size is replaced', t => {
	const dir = tempDir(t);
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(path.join(dir, KEY_FILE), 'short', {mode: 0o600});
	const id = createDeviceIdentity({dir, log: quietLog}).accountId(SARGO_NDUID);
	assert.match(id, /^[0-9a-f]{40}$/);
	assert.strictEqual(fs.statSync(path.join(dir, KEY_FILE)).size, KEY_BYTES);
});

test('device id: a symlinked key is refused, and what it points to is left alone', t => {
	const dir = tempDir(t);
	const elsewhere = path.join(tempDir(t), 'elsewhere');
	fs.writeFileSync(elsewhere, Buffer.alloc(KEY_BYTES, 1));
	fs.symlinkSync(elsewhere, path.join(dir, KEY_FILE));
	assert.throws(() => createDeviceIdentity({dir, log: quietLog}).accountId(SARGO_NDUID),
		e => e.errorCode === 'DEVICE_ID_UNAVAILABLE');
	assert.deepStrictEqual(fs.readFileSync(elsewhere), Buffer.alloc(KEY_BYTES, 1));
});

test('device id: a directory where the key should be is refused', t => {
	const dir = tempDir(t);
	fs.mkdirSync(path.join(dir, KEY_FILE));
	assert.throws(() => createDeviceIdentity({dir, log: quietLog}).accountId(SARGO_NDUID),
		e => e.errorCode === 'DEVICE_ID_UNAVAILABLE');
});

test('device id: a symlinked key directory is refused', t => {
	const real = tempDir(t);
	const link = path.join(tempDir(t), 'link');
	fs.symlinkSync(real, link);
	assert.throws(() => createDeviceIdentity({dir: link, log: quietLog}).accountId(SARGO_NDUID),
		e => e.errorCode === 'DEVICE_ID_UNAVAILABLE');
	assert.deepStrictEqual(fs.readdirSync(real), []);
});

test('device id: a key directory others can read is made private', t => {
	const dir = tempDir(t);
	fs.chmodSync(dir, 0o755);
	createDeviceIdentity({dir, log: quietLog}).accountId(SARGO_NDUID);
	assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});

/* ---- device.js: what goes to the server ---- */

test('the server gets the account id, never the serial number or a MAC address', async () => {
	const pc = fakePc({
		'com.palm.systemservice': {
			'deviceInfo/query': () => ({returnValue: true, device_name: 'sargo', serialNumber: '05DAY1XC8P',
				serial_number: '05DAY1XC8P', wifi_addr: '88:54:1F:2B:B3:6B'}),
			getPreferences: () => ({returnValue: true})
		}
	});
	const device = createDevice({pc, nduId: () => 'ACCOUNT-ID-1', log: quietLog});
	const {deviceInfo} = await device.getDeviceProfile();
	assert.strictEqual(deviceInfo.nduId, 'ACCOUNT-ID-1');
	const params = device.getDeviceParams(deviceInfo);
	assert.strictEqual(params.nduID, 'ACCOUNT-ID-1');
	assert.strictEqual(params.deviceID, 'ACCOUNT-ID-1');
	assert.strictEqual(params.serialNumber, '');
	assert.strictEqual(params.HPSerialNumber, '');
	assert.strictEqual(params.macAddress, '');
	const sent = JSON.stringify([deviceInfo, params, device.getROMTokens(deviceInfo)]);
	assert.ok(sent.indexOf('05DAY1XC8P') === -1, 'the serial number is in ' + sent);
	assert.ok(sent.indexOf('88:54:1F') === -1, 'the MAC address is in ' + sent);
});

test('a device key that cannot be had fails the call, with a code', async () => {
	const pc = fakePc({'com.palm.systemservice': {'deviceInfo/query': () => ({}), getPreferences: () => ({})}});
	const device = createDevice({pc, log: quietLog, nduId: () => {
		const e = new Error('no device id: x');
		e.errorCode = 'DEVICE_ID_UNAVAILABLE';
		throw e;
	}});
	await assert.rejects(device.getDeviceProfile(), e => e.errorCode === 'DEVICE_ID_UNAVAILABLE');
});
