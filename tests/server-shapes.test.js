// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	The bridge against the account server as it is: the request each method
	sends and the replies device.php gives, taken from
	webOSArchive/webos-catalog-service WebService/device.php. An error there
	is {"JSONException": "<CODE>"} at HTTP 200 (device_fail), a wrong password
	{"authFailed": true}; a new account is answered as a sign-in is.
*/

const {test} = require('node:test');
const assert = require('node:assert');

const {createServer} = require('../lib/server');
const {createDevice} = require('../lib/device');
const {createMemoryStore} = require('../lib/store');
const {createHandlers} = require('../lib/handlers');
const {termsText} = require('../lib/terms');
const {quietLog, fakePc, fakeTransport, fakeAccounts, fakeSystem} = require('./helpers');

function makeRig({routes = {}, token = null} = {}) {
	const accounts = fakeAccounts();
	const pc = fakePc({'com.palm.service.accounts': accounts, 'com.palm.systemservice': fakeSystem()});
	const transport = fakeTransport(routes);
	const server = createServer({transport, log: quietLog});
	const device = createDevice({pc, nduId: 'ACCOUNT-ID-1', log: quietLog});
	const store = createMemoryStore(token);
	const handlers = createHandlers({pc, server, store, device, log: quietLog});
	return {handlers: handlers.accountservices, accounts, store, transport};
}

const fail = code => () => ({JSONException: code});
const authInfo = (over = {}) => ({AuthenticateInfoEx: Object.assign({accountAlias: 'new@example.org',
	accountUsername: 'new@example.org', displayName: 'Ada Lovelace', token: 'TK-NEW', accountState: 'ACTIVE'}, over)});
const NEW = {email: ' new@example.org ', password: 'correct horse', firstName: ' Ada ', lastName: 'Lovelace'};

/* ---- the server's error codes ---- */

test('a server error code sent on its own is the error code', async () => {
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {getAccountInfoAggregate: fail('ACCOUNT_NOT_DEFINED_ERROR')}});
	await assert.rejects(rig.handlers.getAggregatedAccountInfo({}), e => e.errorCode === 'ACCOUNT_NOT_DEFINED_ERROR');
});

test('a server error code that is not a word is not passed on as one', () => {
	const server = createServer({transport: async () => ({status: 200, text: '{}'})});
	assert.throws(() => server.asResult({status: 200, json: {JSONException: '<b>x</b> y'}}, 'X', 'FALLBACK'),
		e => e.errorCode === 'FALLBACK');
});

test('sign in with a wrong password is AUTH_FAILED, and nothing is kept', async () => {
	const rig = makeRig({routes: {authenticateFromDevice: () => ({authFailed: true})}});
	await assert.rejects(rig.handlers.authenticateAccount({email: 'me@example.org', password: 'nope'}),
		e => e.errorCode === 'AUTH_FAILED' && !/nope/.test(e.message));
	assert.strictEqual(await rig.store.get(), null);
	assert.strictEqual(rig.accounts.state.created.length, 0);
});

/* ---- createNovaAccount ---- */

test('sign up: createDeviceAccount with what the server asks for, then signed in as the new member', async () => {
	const rig = makeRig({routes: {createDeviceAccount: body => {
		const inn = body.InCreateDeviceAccount;
		assert.deepStrictEqual(inn.account, {email: 'new@example.org', firstName: 'Ada', lastName: 'Lovelace'});
		assert.strictEqual(inn.password, 'correct horse');
		assert.strictEqual(inn.device.nduID, 'ACCOUNT-ID-1');
		assert.strictEqual(inn.device.serialNumber, '');
		return authInfo();
	}}});
	const r = await rig.handlers.createNovaAccount(NEW);
	assert.deepStrictEqual(r, {returnValue: true, accountAlias: 'new@example.org', username: 'Ada Lovelace', profileNamed: true});
	assert.strictEqual(rig.accounts.state.created.length, 1);
	assert.strictEqual(rig.accounts.state.created[0].username, 'Ada Lovelace');
	assert.strictEqual((await rig.handlers.getAccountToken()).token, 'TK-NEW');
});

test('sign up with a profile already there renames it, as sign-in does', async () => {
	const rig = makeRig({routes: {createDeviceAccount: () => authInfo()}});
	rig.accounts.state.accounts.push({_id: 'acct-0', templateId: 'com.palm.palmprofile', username: 'LuneOS'});
	await rig.handlers.createNovaAccount(NEW);
	assert.strictEqual(rig.accounts.state.created.length, 0);
	assert.strictEqual(rig.accounts.state.accounts[0].username, 'Ada Lovelace');
});

test('sign up: each server refusal is its code, and nothing is kept', async () => {
	for (const code of ['INVALID_REQUEST', 'INVALID_EMAIL', 'WEAK_PASSWORD', 'EMAIL_TAKEN', 'ACCOUNT_CREATION_ERROR']) {
		const rig = makeRig({routes: {createDeviceAccount: fail(code)}});
		await assert.rejects(rig.handlers.createNovaAccount(NEW), e => e.errorCode === code, code);
		assert.strictEqual(await rig.store.get(), null, code);
		assert.strictEqual(rig.accounts.state.created.length, 0, code);
	}
});

test('sign up: what is missing or too short is turned down without asking the server', async () => {
	const rig = makeRig({routes: {createDeviceAccount: () => assert.fail('the server was asked')}});
	for (const args of [{}, {email: 'a@b.c', password: 'longenough'}, {email: 'a@b.c', firstName: 'A'},
		{password: 'longenough', firstName: 'A'}, {email: ' ', password: 'longenough', firstName: ' '}]) {
		await assert.rejects(rig.handlers.createNovaAccount(args), e => e.errorCode === 'MISSING_ARGS', JSON.stringify(args));
	}
	await assert.rejects(rig.handlers.createNovaAccount(Object.assign({}, NEW, {password: 'short'})),
		e => e.errorCode === 'WEAK_PASSWORD' && !/short/.test(e.message));
	assert.strictEqual(rig.transport.seen.length, 0);
});

test('sign up: the password length is counted in bytes, as the server counts it', async () => {
	const rig = makeRig({routes: {createDeviceAccount: () => authInfo()}});
	// Five characters, ten bytes: the server takes it, so the bridge must too.
	await rig.handlers.createNovaAccount(Object.assign({}, NEW, {password: 'ééééé'}));
	assert.strictEqual(rig.transport.seen.length, 1);
});

/* ---- isEmailAvailable, getTermsAndConditions ---- */

test('isEmailAvailable: the server\'s answer, from {email}', async () => {
	for (const answer of [true, false]) {
		const rig = makeRig({routes: {isEmailAvailable: body => {
			assert.deepStrictEqual(body, {email: 'new@example.org'});
			return {isEmailAvailable: answer};
		}}});
		assert.deepStrictEqual(await rig.handlers.isEmailAvailable({email: ' new@example.org '}), {returnValue: true, available: answer});
	}
	const odd = makeRig({routes: {isEmailAvailable: () => ({isEmailAvailable: 'yes'})}});
	assert.strictEqual((await odd.handlers.isEmailAvailable({email: 'a@b.c'})).available, false, 'only true is yes');
	await assert.rejects(odd.handlers.isEmailAvailable({}), e => e.errorCode === 'MISSING_ARGS');
});

// The start of what device.php's device_terms_html() sends.
const TERMS_HTML = '<h2>webOS Archive Account &mdash; Terms of Service</h2><p>HP&rsquo;s original webOS services ' +
	'shut down in 2015.</p><h3>1. Your account</h3><p>Optional.</p><p>An unclosed one' +
	'<h3>6. Contact</h3><p>By tapping Continue you agree to these terms.</p>';

test('getTermsAndConditions: the terms as plain text', async () => {
	const rig = makeRig({routes: {getTermsAndConditions: () => ({PALM: TERMS_HTML, GOOGLE: ''})}});
	const r = await rig.handlers.getTermsAndConditions();
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.terms, 'webOS Archive Account — Terms of Service\n\nHP’s original webOS services shut down in 2015.' +
		'\n\n1. Your account\n\nOptional.\n\nAn unclosed one\n\n6. Contact\n\nBy tapping Continue you agree to these terms.');
});

test('getTermsAndConditions: no terms is an error, not an empty agreement', async () => {
	for (const reply of [{PALM: ''}, {PALM: '<p> </p>'}, {GOOGLE: ''}]) {
		const rig = makeRig({routes: {getTermsAndConditions: () => reply}});
		await assert.rejects(rig.handlers.getTermsAndConditions(), e => e.errorCode === 'TERMS_ERROR', JSON.stringify(reply));
	}
});

test('terms text: no tag, script, image or control character gets through', () => {
	const text = termsText('<p>a<script>alert(1)</script>\u0007\u001bb<img src="https://t.example/x.png">c</p>' +
		'<style>p{}</style><!-- note --><a href="https://e.example">link</a>&#7;&#x1F600;&amp;&lt;b&gt;&unknown;<p unclosed');
	assert.strictEqual(text, 'abc\n\nlink😀&<b>&unknown;');
	assert.ok(termsText('x'.repeat(300000)).length <= 64 * 1024);
});

/* ---- signOut, updateUsername ---- */

test('signOut sends the token where the server reads it, so it is revoked there', async () => {
	let seen = null;
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {deauthenticate: body => {
		seen = body;
		return {deauthenticated: true};
	}}});
	await rig.handlers.signOut();
	assert.deepStrictEqual(seen, {token: 'TK'});
	assert.strictEqual(await rig.store.get(), null);
});

test('updateUsername: a name the server turns down changes nothing here', async () => {
	const rig = makeRig({token: {alias: 'me@x', username: 'old', token: 'TK'}, routes: {updateUsername: fail('USERNAME_TAKEN')}});
	rig.accounts.state.accounts.push({_id: 'acct-0', templateId: 'com.palm.palmprofile', username: 'old'});
	await assert.rejects(rig.handlers.updateUsername({username: 'taken'}), e => e.errorCode === 'USERNAME_TAKEN');
	assert.strictEqual((await rig.store.get()).username, 'old');
	assert.strictEqual(rig.accounts.state.accounts[0].username, 'old');
});

test('signed up on the server but the profile cannot be named: still signed in, and says so', async () => {
	// What a device whose bus refused the accounts service saw: the account
	// was made, the reply said "failed", and the next try got EMAIL_TAKEN.
	const rig = makeRig({routes: {createDeviceAccount: () => authInfo()}});
	rig.accounts.listAccounts = () => {
		throw new Error('Denied method call "listAccounts" for category "/"');
	};
	rig.accounts.createAccount = () => {
		throw new Error('Denied method call "createAccount" for category "/"');
	};
	const r = await rig.handlers.createNovaAccount(NEW);
	assert.deepStrictEqual(r, {returnValue: true, accountAlias: 'new@example.org', username: 'Ada Lovelace', profileNamed: false});
	assert.strictEqual((await rig.handlers.getAccountToken()).token, 'TK-NEW', 'the token was not kept');
});

/* ---- the profile editor: name, e-mail, password (device.php) ---- */

test('updateAccountInfo sends the name with the kept token, not what the app passes', async () => {
	let seen = null;
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {updateAccountInfo: (body) => {
		seen = body;
		return {OutUpdateAccountInfo: {returnValue: true}};
	}}});
	const r = await rig.handlers.updateAccountInfo({firstName: ' Ada ', lastName: 'Lovelace', email: 'me@x',
		languageCode: 'en', countryCode: 'US', authToken: 'NOT-MINE'});
	assert.deepStrictEqual(r, {returnValue: true});
	assert.deepStrictEqual(seen, {InUpdateAccountInfo: {authToken: 'TK', account: {firstName: 'Ada', lastName: 'Lovelace'}}});
});

test('updateAccountInfo without a first name does not reach the server', async () => {
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {}});
	await assert.rejects(rig.handlers.updateAccountInfo({firstName: '  ', lastName: 'x'}), e => e.errorCode === 'MISSING_ARGS');
	assert.strictEqual(rig.transport.seen.length, 0);
});

test('changeEmail goes to changeEmailAddress, and the kept alias follows it', async () => {
	let seen = null;
	const rig = makeRig({token: {alias: 'old@x', username: 'h', token: 'TK'}, routes: {changeEmailAddress: (body) => {
		seen = body;
		return {OutChangeEmailAddress: {returnValue: true}};
	}}});
	const r = await rig.handlers.changeEmail({email: ' new@x '});
	assert.deepStrictEqual(r, {returnValue: true, email: 'new@x'});
	assert.deepStrictEqual(seen, {InChangeEmailAddress: {authToken: 'TK', newEmailAddress: 'new@x'}});
	const t = await rig.store.get();
	assert.strictEqual(t.alias, 'new@x');
	assert.strictEqual(t.token, 'TK', 'still signed in');
	assert.strictEqual((await rig.handlers.getAccountToken()).accountAlias, 'new@x');
});

test('changeEmail: the server\'s refusal is its code, and the alias stays', async () => {
	for (const code of ['PAMS1005', 'PAMS1008', 'PAMS1123']) {
		const rig = makeRig({token: {alias: 'old@x', token: 'TK'}, routes: {changeEmailAddress: fail(code)}});
		await assert.rejects(rig.handlers.changeEmail({email: 'new@x'}), e => e.errorCode === code);
		assert.strictEqual((await rig.store.get()).alias, 'old@x');
	}
});

test('changePassword sends the new password with the kept token, and stays signed in', async () => {
	let seen = null;
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {changePassword: (body) => {
		seen = body;
		return {OutChangePassword: {returnValue: true}};
	}}});
	const r = await rig.handlers.changePassword({isResetPassword: true, newPassword: 'correct horse', idToken: 'NOT-MINE'});
	assert.deepStrictEqual(r, {returnValue: true});
	assert.deepStrictEqual(seen, {InChangePassword: {authToken: 'TK', newPassword: 'correct horse'}});
	assert.strictEqual((await rig.store.get()).token, 'TK');
});

test('changePassword: shorter than the server takes is WEAK_PASSWORD here, counted in UTF-8 bytes', async () => {
	const rig = makeRig({token: {alias: 'me@x', token: 'TK'}, routes: {changePassword: () => ({OutChangePassword: {returnValue: true}})}});
	await assert.rejects(rig.handlers.changePassword({newPassword: 'short'}),
		e => e.errorCode === 'WEAK_PASSWORD' && !/short/.test(e.message));
	assert.strictEqual(rig.transport.seen.length, 0);
	// Four characters, eight bytes: the server's strlen takes it.
	await rig.handlers.changePassword({newPassword: 'éééé'});
	assert.strictEqual(rig.transport.seen.length, 1);
});

test('the profile edits need a Community Account signed in', async () => {
	const rig = makeRig({routes: {}});
	await assert.rejects(rig.handlers.updateAccountInfo({firstName: 'Ada'}), e => e.errorCode === 'ACCOUNT_NOT_DEFINED_ERROR');
	await assert.rejects(rig.handlers.changeEmail({email: 'a@b'}), e => e.errorCode === 'ACCOUNT_NOT_DEFINED_ERROR');
	await assert.rejects(rig.handlers.changePassword({newPassword: 'long enough'}), e => e.errorCode === 'ACCOUNT_NOT_DEFINED_ERROR');
	assert.strictEqual(rig.transport.seen.length, 0);
});
