// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	handlers.js: the bus methods of the identity bridge, for the two names the
	LuneOS Accounts app and First Use already call -

	  com.palm.deviceprofile/getDeviceProfile
	  com.palm.accountservices/getAccountToken
	  com.palm.accountservices/authenticateAccount       (sign in)
	  com.palm.accountservices/getAggregatedAccountInfo   (profile view)
	  com.palm.accountservices/syncDeviceName
	  com.palm.accountservices/updateUsername
	  com.palm.accountservices/signOut

	Each translates between the bus call and the webOSArchive backend
	(server.js), and keeps the local token (store.js) that getAccountToken
	serves. Signing in also creates/renames the local palmprofile account
	through com.palm.service.accounts, so the signed-in account becomes the
	device profile - the same thing First Use's createLocalAccount does, but
	named after the member.
*/

const {CloudError, missingArgs} = require('./errors');

const ACCOUNTS = 'palm://com.palm.service.accounts';
const PALMPROFILE_TEMPLATE = 'com.palm.palmprofile';
const CAPABILITIES = [
	{id: 'com.palm.palmprofile.contacts'},
	{id: 'com.palm.palmprofile.calendar'},
	{id: 'com.palm.palmprofile.tasks'},
	{id: 'com.palm.palmprofile.memos'},
	{id: 'com.palm.palmprofile.sms'},
	{id: 'com.palm.palmprofile.voice'},
	{id: 'com.palm.palmprofile.localfilestore'}
];

function randomAttributeOf(info) {
	try {
		const entries = info.moreData && info.moreData.entry;
		if (Array.isArray(entries)) {
			const hit = entries.find(e => e.key === 'randomAttribute');
			return hit ? hit.value : undefined;
		}
	} catch (e) { /* no moreData */ }
	return undefined;
}

function tokenFromAuth(info, fallbackUsername) {
	return {
		alias: info.accountAlias,
		username: info.accountUsername || fallbackUsername,
		token: info.token,
		state: info.accountState,
		authenticatedTime: info.authenticationTime,
		tokenexpireTime: info.expirationTime,
		uniqueId: info.uniqueId,
		jabberId: info.jabberId,
		randomAttribute: randomAttributeOf(info)
	};
}

function createHandlers({pc, server, store, device, log = console} = {}) {

	// ---- create or rename the local palmprofile account, so the signed-in
	// member becomes the device profile. Upsert: never a second parallel row.
	async function upsertLocalProfile(username) {
		let existing = null;
		try {
			const r = await pc.call(ACCOUNTS, 'listAccounts', {templateId: PALMPROFILE_TEMPLATE});
			existing = (r.results || []).find(a => a.templateId === PALMPROFILE_TEMPLATE) || null;
		} catch (e) {
			log.warn && log.warn('upsertLocalProfile: listAccounts failed: ' + (e && e.message || e));
		}
		if (existing) {
			if (existing.username !== username) {
				await pc.call(ACCOUNTS, 'modifyAccount', {accountId: existing._id, object: {username}});
			}
			return existing._id;
		}
		const created = await pc.call(ACCOUNTS, 'createAccount', {
			templateId: PALMPROFILE_TEMPLATE,
			capabilityProviders: CAPABILITIES,
			username,
			credentials: {}
		});
		return created && created._id;
	}

	// ---- com.palm.deviceprofile ----
	async function getDeviceProfile() {
		return device.getDeviceProfile();
	}

	// ---- com.palm.accountservices ----
	async function getAccountToken() {
		const t = await store.get();
		if (!t || !t.token) {
			throw new CloudError('NO_TOKEN', 'not signed in to a Community Account');
		}
		return {
			accountAlias: t.alias,
			accountUsername: t.username || t.alias,
			token: t.token,
			accountState: t.state,
			uniqueId: t.uniqueId,
			jabberId: t.jabberId,
			randomAttribute: t.randomAttribute
		};
	}

	async function authenticateAccount(args) {
		if (!args || !args.email || !args.password) {
			throw missingArgs('authenticateAccount needs email and password');
		}
		const application = args.application || 'ACCT_SRV';
		const {deviceInfo} = await getDeviceProfile();
		const reply = await server.post('authenticateFromDevice', {
			InAuthenticateFromDevice: {
				application,
				accountAlias: args.email,
				password: args.password,
				device: device.getDeviceParams(deviceInfo),
				romToken: device.getROMTokens(deviceInfo)
			}
		});
		const info = server.asResult(reply, 'AuthenticateInfoEx', 'LOGIN_ERROR');
		const username = info.displayName || info.accountAlias;
		await upsertLocalProfile(username);
		await store.save(tokenFromAuth(info, username));
		return {returnValue: true, accountAlias: info.accountAlias, username};
	}

	async function getAggregatedAccountInfo(args) {
		const t = await store.get();
		if (!t || !t.token) {
			throw new CloudError('ACCOUNT_NOT_DEFINED_ERROR', 'not signed in to a Community Account');
		}
		const reply = await server.post('getAccountInfoAggregate', {
			InAccountInfoAggretate: {
				locale: (args && args.locale) || 'en_US',
				token: t.token,
				email: t.alias
			}
		});
		const out = server.asResult(reply, 'OutAccountInfoAggregate', 'ACCOUNT_AGGTE_ERROR_1');
		// Self-heal the local username cache from the server-authoritative value.
		const fresh = out.accountInfo && out.accountInfo.username;
		if (fresh && fresh !== t.username) {
			try {
				await store.merge({username: fresh});
			} catch (e) {
				log.warn && log.warn('getAggregatedAccountInfo: username cache refresh failed: ' + e.message);
			}
		}
		// The Accounts app reads the aggregate as the reply body itself.
		return Object.assign({}, out);
	}

	async function syncDeviceName() {
		const t = await store.get();
		if (!t || !t.token) {
			throw new CloudError('ACCOUNT_INFO_ERROR', 'not signed in');
		}
		const {deviceInfo} = await getDeviceProfile();
		const name = deviceInfo.deviceName || 'LuneOS device';
		try {
			const reply = await server.post('assignDeviceName', {
				InAssignDeviceName: {alias: t.alias, nduId: deviceInfo.nduId, authToken: t.token, name}
			});
			const res = server.asResult(reply, null, 'ASSIGN_DEVICE_NAME_ERROR');
			const assigned = (res && res.InAssignDeviceName && res.InAssignDeviceName.assignedName) || name;
			return {returnValue: true, deviceName: assigned};
		} catch (e) {
			// Best-effort: the profile must still load if the name push fails.
			log.warn && log.warn('syncDeviceName: ' + (e && e.message || e));
			return {returnValue: true, deviceName: name};
		}
	}

	async function updateUsername(args) {
		if (!args || !args.username) {
			throw missingArgs('updateUsername needs a username');
		}
		const t = await store.get();
		if (!t || !t.token) {
			throw new CloudError('NO_TOKEN', 'not signed in');
		}
		// Push to the server, then update the local cache and the account name.
		// updateAccountInfo's full envelope is the one method whose exact server
		// shape is not pinned down here; the push is best-effort so a rename
		// still takes locally, and the server self-heals on the next aggregate.
		try {
			await server.post('updateAccountInfo', {
				InUpdateAccountInfo: {token: t.token, email: t.alias, username: args.username}
			});
		} catch (e) {
			log.warn && log.warn('updateUsername: server push failed (local cache still updated): ' + (e && e.message || e));
		}
		await store.merge({username: args.username});
		try {
			await upsertLocalProfile(args.username);
		} catch (e) {
			log.warn && log.warn('updateUsername: local account rename failed: ' + (e && e.message || e));
		}
		return {returnValue: true, username: args.username};
	}

	async function signOut() {
		const t = await store.get();
		if (t && t.token) {
			try {
				await server.post('deauthenticate', {InDeauthenticate: {token: t.token, alias: t.alias}});
			} catch (e) {
				// Revoke locally even if the server call fails - a stale token
				// on the device is worse than one left live on the server.
				log.warn && log.warn('signOut: server deauthenticate failed: ' + (e && e.message || e));
			}
		}
		await store.clear();
		return {returnValue: true};
	}

	return {
		deviceprofile: {getDeviceProfile},
		accountservices: {
			getAccountToken, authenticateAccount, getAggregatedAccountInfo,
			syncDeviceName, updateUsername, signOut
		},
		upsertLocalProfile
	};
}

module.exports = {createHandlers, tokenFromAuth, PALMPROFILE_TEMPLATE};
