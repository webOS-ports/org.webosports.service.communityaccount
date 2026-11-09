/*
	The bus files under files/sysbus, against how the hub sees this process.

	run-js-service -n <dir> runs the service with the directory's name as its
	appId, and the hub gives that appId the role (which bus names it may
	register) and the client permissions (what it may call). A role or
	permissions keyed by anything else are never applied: the service then
	fails to start with "Invalid permissions for com.palm.accountservices".
	That is what happened on a device after the directory was renamed and
	the role still said com.palm.accountservices.
*/

'use strict';

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SYSBUS = path.join(ROOT, 'files', 'sysbus');
const json = name => JSON.parse(fs.readFileSync(path.join(SYSBUS, name), 'utf8'));

const APP_ID = require('../package.json').name;
const NAMES = ['com.palm.accountservices', 'com.palm.deviceprofile'];

function serviceFile(name) {
	const text = fs.readFileSync(path.join(SYSBUS, name + '.service'), 'utf8');
	return {
		name: (text.match(/^Name=(.*)$/m) || [])[1],
		exec: (text.match(/^Exec=(.*)$/m) || [])[1]
	};
}

test('both .service files start this directory, under the name the hub knows it by', () => {
	for (const name of NAMES) {
		const s = serviceFile(name);
		assert.strictEqual(s.name, name);
		assert.strictEqual(s.exec, '/usr/bin/run-js-service -n /usr/palm/services/' + APP_ID);
	}
});

test('the role is the process\'s own: its appId is the service directory', () => {
	const role = json('com.palm.accountservices.role.json');
	assert.strictEqual(role.appId, APP_ID);
	assert.deepStrictEqual([...role.allowedNames].sort(), [...NAMES].sort());
	for (const name of NAMES) {
		assert.ok(role.permissions.some(p => p.service === name), 'no permissions entry for ' + name);
	}
});

test('the client permissions are keyed by the same appId, and only by it', () => {
	const perm = json('com.palm.accountservices.perm.json');
	assert.deepStrictEqual(Object.keys(perm), [APP_ID]);
	// What it calls: the accounts service for the profile, db8 for the token.
	for (const group of ['accountsservice.operation', 'database.operation', 'deviceprofile.query']) {
		assert.ok(perm[APP_ID].includes(group), 'missing ' + group);
	}
});

test('the groups and api files cover both names', () => {
	const groups = json('com.palm.accountservices.groups.json');
	assert.deepStrictEqual([...groups.allowedNames].sort(), [...NAMES].sort());
	const api = json('com.palm.accountservices.api.json');
	const methods = [].concat(...Object.values(api));
	for (const name of NAMES) {
		assert.ok(methods.some(m => m.startsWith(name + '/')), 'no method of ' + name);
	}
	// Every api group is one the groups file hands out.
	for (const group of Object.keys(api)) {
		assert.ok(group in groups, group + ' is in the api file but not the groups file');
	}
});
