// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	handlers.js: the bus methods of the identity bridge, for the two names the
	LuneOS Accounts app and First Use already call -

	  com.palm.deviceprofile/getDeviceProfile
	  com.palm.accountservices/getAccountToken
	  com.palm.accountservices/authenticateAccount       (sign in)
	  com.palm.accountservices/createNovaAccount         (sign up, and in)
	  com.palm.accountservices/isEmailAvailable
	  com.palm.accountservices/getTermsAndConditions     (as plain text)
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
const {termsText} = require('./terms');

// The account server's minimum (device.php createDeviceAccount).
const MIN_PASSWORD = 8;

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
		// device.php answers a wrong e-mail or password with {"authFailed": true}.
		if (reply.json && reply.json.authFailed === true) {
			throw new CloudError('AUTH_FAILED', 'wrong e-mail address or password');
		}
		return signedIn(server.asResult(reply, 'AuthenticateInfoEx', 'LOGIN_ERROR'));
	}

	// A sign-in or a new account the server has answered with AuthenticateInfoEx:
	// the token is kept, and the member becomes the device profile.
	//
	// The server has signed the device in by now (and made the account, for a
	// sign-up), so that is what the caller is told, even when naming the
	// profile fails: answering "failed" sent the user round again, and a
	// second sign-up got EMAIL_TAKEN for the account the first one made. The
	// profile is named again at the next sign-in, and First Use makes one at
	// its end if there is none. profileNamed says which it was.
	async function signedIn(info) {
		const username = info.displayName || info.accountAlias;
		await store.save(tokenFromAuth(info, username));
		let profileNamed = true;
		try {
			await upsertLocalProfile(username);
		} catch (e) {
			profileNamed = false;
			log.warn && log.warn('signed in, but the profile account was not named: ' + (e && e.message || e));
		}
		return {returnValue: true, accountAlias: info.accountAlias, username, profileNamed};
	}

	/*
		A new Community Account (device.php createDeviceAccount). The server
		wants an e-mail address, a password of at least 8 characters and a first
		name; it signs the device in at once and answers as a sign-in does. Its
		refusals come back as codes: INVALID_REQUEST, INVALID_EMAIL,
		WEAK_PASSWORD, EMAIL_TAKEN, ACCOUNT_CREATION_ERROR. The short password is
		turned down here as well, without a round trip; the server stays the
		judge of the rest. createNovaAccount is the bus name legacy webOS gave it.
	*/
	async function createNovaAccount(args) {
		const email = args && typeof args.email === 'string' ? args.email.trim() : '';
		const firstName = args && typeof args.firstName === 'string' ? args.firstName.trim() : '';
		const lastName = args && typeof args.lastName === 'string' ? args.lastName.trim() : '';
		const password = args && typeof args.password === 'string' ? args.password : '';
		if (!email || !password || !firstName) {
			throw missingArgs('createNovaAccount needs email, password and firstName');
		}
		// Counted as the server counts it (PHP strlen): in UTF-8 bytes.
		if (Buffer.byteLength(password, 'utf8') < MIN_PASSWORD) {
			throw new CloudError('WEAK_PASSWORD', 'the password needs at least ' + MIN_PASSWORD + ' characters');
		}
		const {deviceInfo} = await getDeviceProfile();
		const reply = await server.post('createDeviceAccount', {
			InCreateDeviceAccount: {
				account: {email, firstName, lastName},
				password,
				device: device.getDeviceParams(deviceInfo)
			}
		});
		return signedIn(server.asResult(reply, 'AuthenticateInfoEx', 'ACCOUNT_CREATION_ERROR'));
	}

	// Whether an e-mail address can still be signed up with. An address the
	// server thinks is no address is not available either.
	async function isEmailAvailable(args) {
		const email = args && typeof args.email === 'string' ? args.email.trim() : '';
		if (!email) {
			throw missingArgs('isEmailAvailable needs email');
		}
		const reply = await server.post('isEmailAvailable', {email});
		const r = server.asResult(reply, 'isEmailAvailable', 'EMAIL_CHECK_ERROR');
		return {returnValue: true, available: r === true};
	}

	// The server's terms of service, as plain text (terms.js): what signing up agrees to.
	async function getTermsAndConditions() {
		const reply = await server.post('getTermsAndConditions', {});
		const html = server.asResult(reply, 'PALM', 'TERMS_ERROR');
		const terms = termsText(html);
		if (!terms) {
			throw new CloudError('TERMS_ERROR', 'the account server sent no terms');
		}
		return {returnValue: true, terms};
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
		// The server first (device.php updateUsername): it may turn the name down
		// (USERNAME_TAKEN, or its own rules), and then nothing changes here.
		// (This went to updateAccountInfo, which only sets the display name and
		// reads authToken, so the server never saw a username change.)
		const reply = await server.post('updateUsername', {
			InUpdateUsername: {authToken: t.token, username: args.username}
		});
		const out = server.asResult(reply, 'OutUpdateUsername', 'UPDATE_USERNAME_ERROR');
		const username = (out && typeof out.username === 'string' && out.username) || args.username;
		await store.merge({username});
		try {
			await upsertLocalProfile(username);
		} catch (e) {
			log.warn && log.warn('updateUsername: local account rename failed: ' + (e && e.message || e));
		}
		return {returnValue: true, username};
	}

	async function signOut() {
		const t = await store.get();
		if (t && t.token) {
			// device.php reads the token at the top level and answers
			// {"deauthenticated": true} even for a token it does not know, so a
			// token sent anywhere else was never revoked and stayed good for its
			// year. (It went in an InDeauthenticate envelope.)
			try {
				const reply = await server.post('deauthenticate', {token: t.token});
				if (!(reply.json && reply.json.deauthenticated === true)) {
					log.warn && log.warn('signOut: the server did not confirm the token revoked (status ' + reply.status + ')');
				}
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
			getAccountToken, authenticateAccount, createNovaAccount, isEmailAvailable, getTermsAndConditions,
			getAggregatedAccountInfo, syncDeviceName, updateUsername, signOut
		},
		upsertLocalProfile
	};
}

module.exports = {createHandlers, tokenFromAuth, PALMPROFILE_TEMPLATE};
