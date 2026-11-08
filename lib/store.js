// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	store.js: the local palmprofile token, which every app reads through
	getAccountToken without a network round trip. One record, held in db8 under
	com.palm.account.palmprofiletoken:1 on device, or in memory for tests.

	Shape (the fields getAccountToken returns, from the community
	GetTokenCommandAssistant):
	  { alias, username, token, state, uniqueId, jabberId, randomAttribute,
	    authenticatedTime, tokenexpireTime }
*/

const KIND = 'com.palm.account.palmprofiletoken:1';
const DOC_ID = '_palmprofiletoken';
const OWNER = 'com.palm.accountservices';

// An in-memory store for tests and for a device with no db8 yet.
function createMemoryStore(initial = null) {
	let record = initial;
	return {
		async get() {
			return record ? Object.assign({}, record) : null;
		},
		async save(token) {
			record = Object.assign({}, token);
			return record;
		},
		async merge(fields) {
			record = Object.assign({}, record || {}, fields);
			return record;
		},
		async clear() {
			record = null;
		}
	};
}

// A db8-backed store. Creates its kind lazily (putKind is idempotent); never
// DB.put an existing object (db8 rejects it without a _rev) - merge instead.
function createDbStore({pc, log = console} = {}) {
	const DB = 'palm://com.palm.db/';
	let kindReady = false;

	async function ensureKind() {
		if (kindReady) {
			return;
		}
		try {
			await pc.call(DB, 'putKind', {id: KIND, owner: OWNER, indexes: [{name: 'id', props: [{name: '_id'}]}]});
		} catch (e) {
			log.warn && log.warn('store: putKind ' + KIND + ' failed (tolerated): ' + (e && e.message || e));
		}
		kindReady = true;
	}

	async function read() {
		await ensureKind();
		try {
			const r = await pc.call(DB, 'find', {query: {from: KIND, where: [{prop: '_id', op: '=', val: DOC_ID}]}});
			return (r.results && r.results[0]) || null;
		} catch (e) {
			return null;
		}
	}

	return {
		async get() {
			const rec = await read();
			return rec ? rec : null;
		},
		async save(token) {
			await ensureKind();
			const existing = await read();
			if (existing) {
				await pc.call(DB, 'merge', {objects: [Object.assign({}, token, {_id: DOC_ID, _kind: KIND, _rev: existing._rev})]});
			} else {
				await pc.call(DB, 'put', {objects: [Object.assign({}, token, {_id: DOC_ID, _kind: KIND})]});
			}
			return token;
		},
		async merge(fields) {
			const existing = await read();
			if (!existing) {
				return this.save(fields);
			}
			await pc.call(DB, 'merge', {objects: [Object.assign({}, fields, {_id: DOC_ID, _kind: KIND, _rev: existing._rev})]});
			return Object.assign({}, existing, fields);
		},
		async clear() {
			try {
				await pc.call(DB, 'del', {ids: [DOC_ID]});
			} catch (e) {
				log.warn && log.warn('store: clear failed: ' + (e && e.message || e));
			}
		}
	};
}

module.exports = {createMemoryStore, createDbStore, KIND, DOC_ID};
