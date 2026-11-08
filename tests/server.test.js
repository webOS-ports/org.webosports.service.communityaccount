// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	Hardening of the HTTP client. The request body carries the password (on
	authenticate) and the bearer token (on every other call), so the transport
	must be TLS and must not forward those to another origin on a redirect, and
	a backend application error (JSONException, often at HTTP 200) must surface
	as a thrown, mapped error rather than a silent empty success.
*/

const {test} = require('node:test');
const assert = require('node:assert');

const {createServer} = require('../lib/server');

test('a non-https base is refused when using the real transport', () => {
	assert.throws(() => createServer({base: 'http://evil.example/x?m='}), /https/i);
	// An injected transport (tests) is exempt: no real network, no cleartext.
	assert.doesNotThrow(() => createServer({base: 'http://x/?m=', transport: async () => ({status: 200, text: '{}'})}));
});

test('post maps a transport failure to SERVER_UNREACHABLE without leaking the body', async () => {
	let seenBody = null;
	const server = createServer({
		transport: async (url, opts) => { seenBody = opts.body; throw new Error('ECONNRESET'); }
	});
	await assert.rejects(() => server.post('authenticateFromDevice', {InAuthenticateFromDevice: {password: 'hunter2'}}),
		e => {
			assert.strictEqual(e.errorCode, 'SERVER_UNREACHABLE');
			assert.ok(!/hunter2/.test(String(e.message)), 'the password must not appear in the error');
			return true;
		});
	assert.ok(/hunter2/.test(seenBody), 'the password did go to the transport, just not into the error');
});

test('asResult throws the backend JSONException code and text', () => {
	const server = createServer({transport: async () => ({status: 200, text: '{}'})});
	assert.throws(() => server.asResult({status: 200, json: {JSONException: {errorCode: 'PAMS1106', errorText: 'no account'}}}),
		e => e.errorCode === 'PAMS1106' && /no account/.test(e.message));
});

test('asResult rejects a non-200 and a non-JSON reply', () => {
	const server = createServer({transport: async () => ({status: 200, text: '{}'})});
	assert.throws(() => server.asResult({status: 503, json: null}), e => e.errorCode === 'STATUS_ERROR');
	assert.throws(() => server.asResult({status: 200, json: null}), e => e.errorCode === 'BAD_REPLY');
});
