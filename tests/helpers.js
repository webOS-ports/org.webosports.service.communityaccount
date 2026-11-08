// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const quietLog = {log() {}, warn() {}, error() {}};

// A stand-in palmcall: services is { '<busName>': { '<method>': (args) => reply } }.
function fakePc(services) {
	const calls = [];
	return {
		calls,
		call(uri, method, args) {
			const id = String(uri).replace(/^palm:\/\//, '').replace(/^luna:\/\//, '');
			calls.push({id, method, args});
			const svc = services[id];
			if (!svc || typeof svc[method] !== 'function') {
				return Promise.reject(new Error('no ' + id + '/' + method));
			}
			return Promise.resolve().then(() => svc[method](args || {}));
		}
	};
}

// A stand-in HTTP transport for lib/server.js. routes is
// { '<device.php method>': (requestBody) => replyObject }. A reply may carry
// __status (HTTP code) and/or be a { JSONException } object.
function fakeTransport(routes) {
	const seen = [];
	const transport = async (url, opts) => {
		const method = String(url).split('m=').pop();
		const body = JSON.parse((opts && opts.body) || '{}');
		seen.push({method, body});
		const route = routes[method];
		const reply = route ? route(body) : {JSONException: {errorCode: 'NO_ROUTE', errorText: 'no route for ' + method}};
		const status = reply.__status || 200;
		delete reply.__status;
		return {status, text: JSON.stringify(reply)};
	};
	transport.seen = seen;
	return transport;
}

// A fake com.palm.service.accounts that records what the bridge does to the
// local palmprofile account.
function fakeAccounts() {
	const state = {accounts: [], created: [], modified: []};
	return {
		state,
		listAccounts(args) {
			const t = args.templateId;
			return {returnValue: true, results: t ? state.accounts.filter(a => a.templateId === t) : state.accounts};
		},
		createAccount(args) {
			const acct = Object.assign({_id: 'acct-' + (state.accounts.length + 1)}, args);
			state.accounts.push(acct);
			state.created.push(acct);
			return acct;
		},
		modifyAccount(args) {
			const a = state.accounts.find(x => x._id === args.accountId);
			if (a) {
				Object.assign(a, args.object);
			}
			state.modified.push(args);
			return {returnValue: true};
		}
	};
}

// A fake systemservice with a device name and model.
function fakeSystem({deviceName = 'Mandy phone', modelName = 'TouchPad'} = {}) {
	return {
		'deviceInfo/query': () => ({returnValue: true, device_name: 'topaz', modelName}),
		getPreferences: (args) => {
			const out = {returnValue: true};
			if ((args.keys || []).includes('deviceName')) {
				out.deviceName = deviceName;
			}
			return out;
		}
	};
}

module.exports = {quietLog, fakePc, fakeTransport, fakeAccounts, fakeSystem};
