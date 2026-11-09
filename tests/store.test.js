// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	The db8 token store against a stand-in db8 that keeps the rules the real
	one refused the token by (db8 src/db/MojDb.cpp, MojDbKind.cpp, and tried
	on a device): a kind is registered only by the caller that owns it; an
	_id of more than 16 characters is "Invalid _id length", and one of 12 to
	16 is read as a shard id ("Shard ... not found").
*/

const {test} = require('node:test');
const assert = require('node:assert');

const {createDbStore, KIND, DOC_ID, OWNER} = require('../lib/store');
const {quietLog} = require('./helpers');
const {createPalmCall} = require('../lib/palmcall');

// The appId db8 sees the bridge as (run-js-service -n: the directory name).
const CALLER = 'org.webosports.service.communityaccount';

function fakeDb8({caller = CALLER} = {}) {
	const kinds = {};
	const objects = {};
	let rev = 100;
	const fail = text => Promise.reject(new Error(text));
	const db = {
		kinds, objects,
		call(uri, method, args) {
			assert.strictEqual(uri, 'palm://com.palm.db/');
			switch (method) {
			case 'putKind':
				if (kinds[args.id] ? kinds[args.id].owner !== caller : args.owner !== caller) {
					return fail('db: permission denied');
				}
				kinds[args.id] = {owner: args.owner};
				return Promise.resolve({returnValue: true});
			case 'find': {
				const k = args.query.from;
				if (!kinds[k]) {
					return fail('kind not registered: \'' + k + '\'');
				}
				const w = args.query.where[0];
				const results = Object.values(objects).filter(o => o._kind === k && o[w.prop] === w.val);
				return Promise.resolve({returnValue: true, results: results.map(o => Object.assign({}, o))});
			}
			case 'put':
			case 'merge':
				for (const o of args.objects) {
					if (!kinds[o._kind]) {
						return fail('kind not registered');
					}
					if (o._id.length > 16) {
						return fail('db: Invalid _id length');
					}
					if (o._id.length > 11) {
						return fail('Shard 3597431511 not found');
					}
					if (method === 'merge' && (!objects[o._id] || objects[o._id]._rev !== o._rev)) {
						return fail('db: revision mismatch');
					}
					objects[o._id] = Object.assign({}, method === 'merge' ? objects[o._id] : {}, o, {_rev: ++rev});
				}
				return Promise.resolve({returnValue: true});
			case 'del':
				for (const id of args.ids) {
					delete objects[id];
				}
				return Promise.resolve({returnValue: true});
			default:
				return fail('no method ' + method);
			}
		}
	};
	return db;
}

const TOKEN = {alias: 'member@example.org', username: 'Member', token: 'TK', state: 'ACTIVE'};

test('the kind is owned by the bridge itself, so db8 registers it', () => {
	assert.strictEqual(OWNER, CALLER);
	assert.strictEqual(KIND, 'com.palm.account.palmprofiletoken:1');
});

test('the token id is one db8 takes', () => {
	assert.ok(DOC_ID.length <= 11, DOC_ID);
});

test('a token saved on a fresh device is read back, merged, and cleared', async () => {
	const db = fakeDb8();
	const store = createDbStore({pc: db, log: quietLog});
	assert.strictEqual(await store.get(), null);
	await store.save(TOKEN);
	assert.strictEqual(db.kinds[KIND].owner, CALLER);
	const got = await store.get();
	assert.strictEqual(got.token, 'TK');
	assert.strictEqual(got.alias, 'member@example.org');

	await store.save(Object.assign({}, TOKEN, {token: 'TK2'}));
	assert.strictEqual((await store.get()).token, 'TK2', 'a second sign-in did not replace the token');
	await store.merge({username: 'New name'});
	assert.strictEqual((await store.get()).username, 'New name');

	await store.clear();
	assert.strictEqual(await store.get(), null);
});

test('a kind db8 would not register is tried again, and the save says it failed', async () => {
	const db = fakeDb8({caller: 'someone.else'});
	const store = createDbStore({pc: db, log: quietLog});
	await assert.rejects(store.save(TOKEN), /kind not registered/);
	let putKinds = 0;
	const call = db.call;
	db.call = (u, m, a) => {
		if (m === 'putKind') {
			putKinds++;
		}
		return call(u, m, a);
	};
	await assert.rejects(store.save(TOKEN));
	assert.ok(putKinds >= 1, 'putKind was not tried again');
});

test('a save db8 turns down does not put the token in the error, or in the log', async () => {
	const logged = [];
	const log = {log() {}, warn: m => logged.push(String(m)), error: m => logged.push(String(m))};
	// db8 answering as it did on the device.
	const bus = {call: async (url) => (/putKind$/.test(url) ? {returnValue: true}
		: /find$/.test(url) ? {returnValue: true, results: []}
			: {returnValue: false, errorCode: -3968, errorText: 'db: Invalid _id length'})};
	const store = createDbStore({pc: createPalmCall(bus), log});
	const secret = '912b546e560ae3ce475fd3174efa52e5';
	await assert.rejects(store.save(Object.assign({}, TOKEN, {token: secret})), e => {
		assert.ok(/Invalid _id length/.test(e.message), e.message);
		assert.ok(!e.message.includes(secret), 'the token is in the error: ' + e.message);
		return true;
	});
	assert.ok(!logged.some(m => m.includes(secret)));
	await assert.rejects(store.merge({authToken: secret}).then(() => store.save({token: secret})),
		e => !e.message.includes(secret));
});
