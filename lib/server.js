// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	server.js: the HTTP client to the webOS Community Account backend
	(webOSArchive's device.php), reproduced from the community
	palm_profile_util.js. The base is

	  https://appcatalog.webosarchive.org/WebService/device.php?m=<method>

	and each call POSTs a JSON body and reads a JSON reply. The method name is
	appended to the base; the request and reply use the backend's own In.../Out...
	envelopes (e.g. InAccountInfoAggretate / OutAccountInfoAggregate), kept
	exactly so the same server serves LuneOS and webOS CE from one account
	namespace.

	Unlike the legacy service, this runs on modern Node, whose TLS handshakes
	with the Cloudflare origin directly - so it uses global fetch and does NOT
	shell out to /usr/bin/curl. The transport is injectable, so tests exercise
	every handler without a network.

	A reply is { status, json, text }. The backend returns a { JSONException }
	body on an application error (often with HTTP 200), so callers check for
	that as well as the status - see asResult().
*/

const {CloudError} = require('./errors');

const DEFAULT_BASE = 'https://appcatalog.webosarchive.org/WebService/device.php?m=';
const DEFAULT_TIMEOUT_MS = 30000;
// A well-formed account reply is a few KB; refuse to buffer a runaway body so a
// misbehaving or hijacked endpoint cannot exhaust memory.
const MAX_REPLY_BYTES = 1024 * 1024;

function createServer({base = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, transport, log = console} = {}) {
	if (transport === undefined && !/^https:/i.test(base)) {
		// The request body carries the password (authenticate) and the bearer
		// token (every other call); refuse to send them in cleartext.
		throw new Error('account server base must be https: ' + base);
	}
	// transport(url, {method, headers, body}) -> { status, text }. Defaults to
	// fetch; a test passes its own.
	const send = transport || (async (url, opts) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// redirect:'error' - never let a 30x forward the credential-bearing
			// POST to another origin. Reject an over-length body before buffering.
			const res = await fetch(url, Object.assign({signal: controller.signal, redirect: 'error'}, opts));
			const declared = Number(res.headers.get('content-length'));
			if (Number.isFinite(declared) && declared > MAX_REPLY_BYTES) {
				throw new Error('account server reply too large (' + declared + ' bytes)');
			}
			const text = await res.text();
			if (text.length > MAX_REPLY_BYTES) {
				throw new Error('account server reply too large');
			}
			return {status: res.status, text};
		} finally {
			clearTimeout(timer);
		}
	});

	async function post(method, body) {
		const url = base + method;
		let reply;
		try {
			reply = await send(url, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', 'Connection': 'close'},
				body: JSON.stringify(body || {})
			});
		} catch (e) {
			throw new CloudError('SERVER_UNREACHABLE', method + ': ' + (e && e.message || e));
		}
		let json = null;
		try {
			json = reply.text ? JSON.parse(reply.text) : null;
		} catch (e) {
			json = null;
		}
		return {status: reply.status, text: reply.text, json};
	}

	// Reads a backend reply and returns the named envelope, or throws the
	// mapped error. The backend signals an application error with a JSONException
	// body (even at HTTP 200) or a non-200 status.
	function asResult(reply, envelope, errorCode) {
		if (reply.json && reply.json.JSONException) {
			const ex = reply.json.JSONException;
			throw new CloudError(ex.errorCode || errorCode || 'SERVER_ERROR',
				ex.errorText || ex.message || 'account server error', {status: reply.status});
		}
		if (reply.status && reply.status !== 200) {
			throw new CloudError('STATUS_ERROR', 'account server returned ' + reply.status, {status: reply.status});
		}
		if (!reply.json) {
			throw new CloudError('BAD_REPLY', 'account server reply was not JSON', {status: reply.status});
		}
		if (envelope && reply.json[envelope] === undefined) {
			throw new CloudError(errorCode || 'BAD_REPLY', 'account server reply has no ' + envelope, {status: reply.status});
		}
		return envelope ? reply.json[envelope] : reply.json;
	}

	return {post, asResult, base};
}

module.exports = {createServer, DEFAULT_BASE};
