// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	device.js: this device's profile, and its mapping into the shapes the
	account backend expects (getDeviceParams / getROMTokens, from the community
	palm_profile_util.js). The server upserts by nduId, so the nduId is the one
	field that must be right; the rest default to "" where LuneOS has no
	equivalent of a 2011 Palm ROM token.
*/

const SYSTEM = 'luna://com.palm.systemservice';

function createDevice({pc, nduId, log = console} = {}) {
	// The device profile the bus returns: { returnValue, deviceInfo }.
	async function getDeviceProfile() {
		let info = {nduId};
		try {
			const r = await pc.call('palm://com.palm.systemservice', 'deviceInfo/query', {});
			info.deviceName = r.device_name || r.deviceName || '';
			info.deviceModel = r.modelName || r.device_name || '';
			info.firmwareVersion = r.platformVersion || r.firmware_version || '';
			info.serialNumber = r.serialNumber || '';
			info.platform = 'luneos';
		} catch (e) {
			log.warn && log.warn('device: deviceInfo/query failed: ' + (e && e.message || e));
		}
		try {
			const p = await pc.call(SYSTEM, 'getPreferences', {keys: ['deviceName']});
			if (p && p.deviceName) {
				info.deviceName = p.deviceName;
			}
		} catch (e) { /* a missing name is not fatal */ }
		if (!info.deviceName) {
			info.deviceName = 'LuneOS device';
		}
		info.nduId = nduId;
		return {returnValue: true, deviceInfo: info};
	}

	// The "device" block of an authenticate request.
	function getDeviceParams(info) {
		info = info || {};
		const id = info.deviceId || info.nduId || nduId;
		return {
			serialNumber: info.serialNumber || '',
			HPSerialNumber: info.HPSerialNumber || '',
			carrier: info.carrier || '',
			dataNetwork: info.dataNetwork || '',
			deviceID: id,
			phoneNumber: info.phoneNumber || '',
			nduID: info.nduId || nduId,
			deviceModel: info.deviceModel || '',
			firmwareVersion: info.firmwareVersion || '',
			network: info.network || '',
			platform: info.platform || 'luneos',
			macAddress: info.macAddress || '',
			homeMcc: info.homeMcc || '',
			homeMnc: info.homeMnc || '',
			currentMcc: info.currentMcc || '',
			currentMnc: info.currentMnc || '',
			productSku: info.productSku || ''
		};
	}

	// The "romToken" block. LuneOS has none of HP's signed ROM tokens; the
	// community backend accepts the call without them, so these are "".
	function getROMTokens(info) {
		info = info || {};
		return {
			buildVariant: info.dmSets || '',
			serverAuthType: info.serverAuthType || '',
			serverPwd: info.serverPwd || '',
			serverNonce: info.serverNonce || '',
			clientCredential: info.clientCredential || '',
			clientPwd: info.clientPwd || '',
			clientNonce: info.clientNonce || '',
			softwareBuildBranch: info.softwareBuildBranch || '',
			swUpdateTarget: info.swUpdateTarget || '',
			softwareBuildNumber: info.softwareVersion || info.firmwareVersion || ''
		};
	}

	return {getDeviceProfile, getDeviceParams, getROMTokens};
}

module.exports = {createDevice};
