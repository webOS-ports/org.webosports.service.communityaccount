// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	com.palm.service.communityaccount: the LuneOS identity bridge.

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

const ACCOUNTSERVICES = 'com.palm.accountservices';
const DEVICEPROFILE = 'com.palm.deviceprofile';

const TIMEOUTS = {authenticateAccount: 45, getAggregatedAccountInfo: 45, syncDeviceName: 45, signOut: 30};

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
// transport, a store, a fixed nduId and a base URL.
async function start({palmbus, exit, idleMs, log = console, transport, store, nduId, base} = {}) {
	const busA = createBus({palmbus, name: ACCOUNTSERVICES, exit, idleMs, log});
	const busB = createBus({palmbus, name: DEVICEPROFILE, exit, idleMs, log});
	const pc = createPalmCall(busA);
	const id = nduId || readNduid({log});

	const server = createServer({base, transport, log});
	const device = createDevice({pc, nduId: id, log});
	const tokenStore = store || createDbStore({pc, log});
	const handlers = createHandlers({pc, server, store: tokenStore, device, log});

	serveTable(busA, ACCOUNTSERVICES, handlers.accountservices, log);
	serveTable(busB, DEVICEPROFILE, handlers.deviceprofile, log);

	log.log('com.palm.service.communityaccount: up (nduId ' + id + ', node ' + process.version + ')');
	return {busA, busB, handlers, nduId: id};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = 'com.palm.service.communityaccount';
	running = start({palmbus: require('palmbus')});
	running.catch(e => {
		console.error('com.palm.service.communityaccount: failed to start: ' + ((e && e.stack) || e));
		process.exit(1);
	});
	return running;
}

module.exports = {start, run, ACCOUNTSERVICES, DEVICEPROFILE};

if (require.main === module) {
	run();
}
