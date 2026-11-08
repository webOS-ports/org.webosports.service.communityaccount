// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	Smoke test over the stand-in palmbus: start() registers BOTH bus names on
	one process and wires the handlers onto the real bus.js runtime, exactly as
	the device launcher would. getDeviceProfile makes no network call, so it
	proves the deviceprofile name end to end; getAccountToken proves the
	accountservices name answers (NO_TOKEN, since nothing is signed in).
*/

const {test} = require('node:test');
const assert = require('node:assert');

const {start} = require('../service');
const {createPalmbus} = require('./palmbus');
const {createMemoryStore} = require('../lib/store');
const {quietLog} = require('./helpers');

test('both bus names answer on the bus', async () => {
	// systemservice answers deviceInfo/getPreferences for getDeviceProfile.
	const palmbus = createPalmbus(async (uri, args) => {
		if (uri.indexOf('com.palm.systemservice') !== -1) {
			return {returnValue: true, device_name: 'topaz', modelName: 'TouchPad'};
		}
		return {returnValue: true};
	});

	await start({palmbus, store: createMemoryStore(null), nduId: 'SMOKE-NDU', idleMs: 0, log: quietLog, exit: () => {}, transport: async () => ({status: 200, text: '{}'})});

	const dp = JSON.parse(await palmbus.request('com.palm.deviceprofile', 'getDeviceProfile', {}));
	assert.strictEqual(dp.returnValue, true);
	assert.strictEqual(dp.deviceInfo.nduId, 'SMOKE-NDU');

	const tok = JSON.parse(await palmbus.request('com.palm.accountservices', 'getAccountToken', {}));
	assert.strictEqual(tok.returnValue, false);
	assert.strictEqual(tok.errorCode, 'NO_TOKEN');
});
