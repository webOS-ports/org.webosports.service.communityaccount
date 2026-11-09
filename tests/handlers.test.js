// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const {test} = require('node:test');
const assert = require('node:assert');

const {createServer} = require('../lib/server');
const {createDevice} = require('../lib/device');
const {createMemoryStore} = require('../lib/store');
const {createHandlers} = require('../lib/handlers');
const {quietLog, fakePc, fakeTransport, fakeAccounts, fakeSystem} = require('./helpers');

function makeRig({routes = {}, token = null} = {}) {
	const accounts = fakeAccounts();
	const pc = fakePc({
		'com.palm.service.accounts': accounts,
		'com.palm.systemservice': fakeSystem()
	});
	const transport = fakeTransport(routes);
	const server = createServer({transport, log: quietLog});
	const device = createDevice({pc, nduId: 'NDU123', log: quietLog});
	const store = createMemoryStore(token);
	const handlers = createHandlers({pc, server, store, device, log: quietLog});
	return {handlers, accounts, store, transport, pc};
}

test('getDeviceProfile returns the nduId and device name', async () => {
	const {handlers} = makeRig();
	const r = await handlers.deviceprofile.getDeviceProfile();
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.deviceInfo.nduId, 'NDU123');
	assert.strictEqual(r.deviceInfo.deviceName, 'Mandy phone');
});

test('sign in: authenticates, creates the local account, saves the token', async () => {
	const rig = makeRig({
		routes: {
			authenticateFromDevice: (body) => {
				assert.strictEqual(body.InAuthenticateFromDevice.accountAlias, 'me@example.org');
				assert.strictEqual(body.InAuthenticateFromDevice.device.nduID, 'NDU123');
				return {AuthenticateInfoEx: {accountAlias: 'me@example.org', accountUsername: 'mandy', token: 'TK-1', accountState: 'A', displayName: 'Mandy'}};
			}
		}
	});
	const r = await rig.handlers.accountservices.authenticateAccount({email: 'me@example.org', password: 'pw', application: 'ACCT_SRV'});
	assert.strictEqual(r.returnValue, true);

	// Local palmprofile account created, named after the member.
	assert.strictEqual(rig.accounts.state.created.length, 1);
	assert.strictEqual(rig.accounts.state.created[0].username, 'Mandy');
	assert.strictEqual(rig.accounts.state.created[0].templateId, 'com.palm.palmprofile');

	// Token saved and served to other apps.
	const tok = await rig.handlers.accountservices.getAccountToken();
	assert.strictEqual(tok.token, 'TK-1');
	assert.strictEqual(tok.accountAlias, 'me@example.org');
	assert.strictEqual(tok.accountUsername, 'mandy');
});

test('getAccountToken without a token fails with NO_TOKEN', async () => {
	const {handlers} = makeRig();
	await assert.rejects(() => handlers.accountservices.getAccountToken(), e => e.errorCode === 'NO_TOKEN');
});

test('sign in renames an existing palmprofile account instead of making a second', async () => {
	const rig = makeRig({routes: {authenticateFromDevice: () => ({AuthenticateInfoEx: {accountAlias: 'me@x', token: 'TK', displayName: 'Renamed'}})}});
	rig.accounts.state.accounts.push({_id: 'acct-0', templateId: 'com.palm.palmprofile', username: 'LuneOS'});
	await rig.handlers.accountservices.authenticateAccount({email: 'me@x', password: 'pw'});
	assert.strictEqual(rig.accounts.state.created.length, 0, 'no new account');
	assert.strictEqual(rig.accounts.state.accounts[0].username, 'Renamed', 'existing account renamed');
});

test('getAggregatedAccountInfo uses the token and self-heals the username cache', async () => {
	const rig = makeRig({
		token: {alias: 'me@x', username: 'old', token: 'TK'},
		routes: {
			getAccountInfoAggregate: (body) => {
				assert.strictEqual(body.InAccountInfoAggretate.token, 'TK');
				return {OutAccountInfoAggregate: {accountInfo: {username: 'new-handle'}, accountDevices: [{nduId: 'NDU123'}]}};
			}
		}
	});
	const out = await rig.handlers.accountservices.getAggregatedAccountInfo({locale: 'en_US'});
	assert.ok(out.accountInfo);
	assert.strictEqual(out.accountInfo.username, 'new-handle');
	assert.strictEqual((await rig.store.get()).username, 'new-handle', 'local cache refreshed');
});

test('a backend JSONException becomes a thrown error', async () => {
	const rig = makeRig({
		token: {alias: 'me@x', token: 'TK'},
		routes: {getAccountInfoAggregate: () => ({JSONException: {errorCode: 'PAMS1106', errorText: 'no account'}})}
	});
	await assert.rejects(() => rig.handlers.accountservices.getAggregatedAccountInfo({}), e => e.errorCode === 'PAMS1106');
});

test('syncDeviceName pushes the name and returns the assigned one', async () => {
	const rig = makeRig({
		token: {alias: 'me@x', token: 'TK'},
		routes: {
			assignDeviceName: (body) => {
				assert.strictEqual(body.InAssignDeviceName.nduId, 'NDU123');
				assert.strictEqual(body.InAssignDeviceName.authToken, 'TK');
				return {InAssignDeviceName: {assignedName: 'Mandy phone (2)'}};
			}
		}
	});
	const r = await rig.handlers.accountservices.syncDeviceName();
	assert.strictEqual(r.deviceName, 'Mandy phone (2)');
});

test('syncDeviceName is best-effort: a server error still returns the local name', async () => {
	const rig = makeRig({
		token: {alias: 'me@x', token: 'TK'},
		routes: {assignDeviceName: () => ({__status: 500})}
	});
	const r = await rig.handlers.accountservices.syncDeviceName();
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.deviceName, 'Mandy phone');
});

test('signOut clears the local token', async () => {
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {deauthenticate: () => ({returnValue: true})}});
	await rig.handlers.accountservices.signOut();
	assert.strictEqual(await rig.store.get(), null);
	await assert.rejects(() => rig.handlers.accountservices.getAccountToken(), e => e.errorCode === 'NO_TOKEN');
});

test('signOut revokes locally even when the server call fails', async () => {
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {deauthenticate: () => ({__status: 500})}});
	const r = await rig.handlers.accountservices.signOut();
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(await rig.store.get(), null);
});

test('updateUsername updates the cache and renames the local account', async () => {
	const rig = makeRig({token: {alias: 'me@x', username: 'old', token: 'TK'}, routes: {updateUsername: (body) => {
		assert.deepStrictEqual(body, {InUpdateUsername: {authToken: 'TK', username: 'fresh'}});
		return {OutUpdateUsername: {username: 'fresh'}};
	}}});
	rig.accounts.state.accounts.push({_id: 'acct-0', templateId: 'com.palm.palmprofile', username: 'old'});
	const r = await rig.handlers.accountservices.updateUsername({username: 'fresh'});
	assert.strictEqual(r.username, 'fresh');
	assert.strictEqual((await rig.store.get()).username, 'fresh');
	assert.strictEqual(rig.accounts.state.accounts[0].username, 'fresh');
});
