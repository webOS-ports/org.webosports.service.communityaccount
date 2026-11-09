// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	org.webosports.service.communityaccount: the LuneOS identity bridge.

	The Accounts app's palmID flow and First Use already call
	com.palm.accountservices and com.palm.deviceprofile (keyed by nduId), but
	nothing on LuneOS answers them against the webOS Community Account backend.
	This is that backend bridge. One process registers both bus names and
	translates their methods to webOSArchive's device.php (lib/server.js),
	keeping the local token (lib/store.js) that getAccountToken serves.

	Everything is injected (lib/handlers.js), so the whole bridge runs off-device
	against a stand-in bus and a fake HTTP transport - see tests/.
*/

const {createBus} = require('./lib/bus');
const {createPalmCall} = require('./lib/palmcall');
const {createServer} = require('./lib/server');
const {createDevice} = require('./lib/device');
const {createDbStore} = require('./lib/store');
const {createHandlers} = require('./lib/handlers');
const {method, DEFAULT_TIMEOUT_S} = require('./lib/mojo');
const {readNduid} = require('./lib/nduid');
const {createDeviceIdentity} = require('./lib/deviceid');

const ACCOUNTSERVICES = 'com.palm.accountservices';
const DEVICEPROFILE = 'com.palm.deviceprofile';

const TIMEOUTS = {
	authenticateAccount: 45, createNovaAccount: 45, isEmailAvailable: 45, getTermsAndConditions: 45,
	getAggregatedAccountInfo: 45, syncDeviceName: 45, updateUsername: 45, updateAccountInfo: 45,
	changeEmail: 45, changePassword: 45, signOut: 30
};

function serveTable(bus, serviceName, methods, log) {
	const table = {};
	for (const name of Object.keys(methods)) {
		const timeoutS = TIMEOUTS[name] || DEFAULT_TIMEOUT_S;
		const m = method(serviceName, name, methods[name], {timeoutS, log});
		table[name] = {raw: true, timeoutMs: (timeoutS + 10) * 1000, handler: m.handler};
	}
	table.__quit = {
		raw: true,
		handler: () => {
			setTimeout(() => bus.leave(0, 'asked to quit (__quit)'), 100);
			return {returnValue: true};
		}
	};
	bus.serve(table);
}

// start(): both bus names on one process. Options let a test inject an HTTP
// transport, a store, a fixed account device id (nduId), a directory for the
// device key and a base URL.
async function start({palmbus, exit, idleMs, log = console, transport, store, nduId, deviceDir, base} = {}) {
	const busA = createBus({palmbus, name: ACCOUNTSERVICES, exit, idleMs, log});
	const busB = createBus({palmbus, name: DEVICEPROFILE, exit, idleMs, log});
	const pc = createPalmCall(busA);
	// What the account server knows this device by: derived from the
	// platform nduId with this device's own key (lib/deviceid.js).
	let platformNduId = null;
	const identity = createDeviceIdentity({dir: deviceDir, log});
	const id = nduId ? () => nduId : () => {
		if (platformNduId === null) {
			platformNduId = readNduid({log});
		}
		return identity.accountId(platformNduId);
	};

	const server = createServer({base, transport, log});
	const device = createDevice({pc, nduId: id, log});
	const tokenStore = store || createDbStore({pc, log});
	const handlers = createHandlers({pc, server, store: tokenStore, device, log});

	serveTable(busA, ACCOUNTSERVICES, handlers.accountservices, log);
	serveTable(busB, DEVICEPROFILE, handlers.deviceprofile, log);

	// No id in the log: it is what the server knows this device by.
	log.log('org.webosports.service.communityaccount: up (' + (nduId ? 'fixed device id' : 'device id from nyx and the device key') + ', node ' + process.version + ')');
	return {busA, busB, handlers, nduId: id};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = 'org.webosports.service.communityaccount';
	running = start({palmbus: require('palmbus')});
	running.catch(e => {
		console.error('org.webosports.service.communityaccount: failed to start: ' + ((e && e.stack) || e));
		process.exit(1);
	});
	return running;
}

module.exports = {start, run, ACCOUNTSERVICES, DEVICEPROFILE};

if (require.main === module) {
	run();
}
