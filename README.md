com.palm.service.communityaccount
=================================

Summary
-------
The LuneOS identity bridge: answers `com.palm.accountservices` and
`com.palm.deviceprofile` against the webOS Community Account backend.

Description
-----------

The LuneOS Accounts app's palmID flow and First Use already call
`palm://com.palm.accountservices/...` and `palm://com.palm.deviceprofile/...`
(keyed by nduId), but nothing on LuneOS answers them against a live account
server. This service is that missing backend bridge. One process registers both
bus names and translates their methods to webOSArchive's account server
(`https://appcatalog.webosarchive.org/WebService/device.php?m=<method>`), keeping
the local token that `getAccountToken` serves to every other app.

It is a clean modern-Node (>=22) reimplementation of the community
`palm_profile_util.js` + its command assistants, on LuneOS's own service runtime.
Two things change from the legacy service, both because modern Node is a better
host than webOS 3.0.5's node 0.4.12:

- **Native TLS, no `curl` shellout.** The legacy service could not handshake with
  the Cloudflare origin on node 0.4.12's TLS and shelled out to `/usr/bin/curl`.
  Modern Node's `fetch` connects directly; the HTTP transport is injectable, so
  tests run every handler with no network.
- **Upsert, don't duplicate.** Signing in creates *or renames* the one local
  `com.palm.palmprofile` account (named after the member), so the signed-in
  account becomes the device profile — the same thing First Use's
  `createLocalAccount` does, never a second parallel row.

Bus API
-------

```
com.palm.deviceprofile/getDeviceProfile        {}                       -> { returnValue, deviceInfo:{ nduId, deviceName, ... } }
com.palm.accountservices/getAccountToken       {}                       -> { accountAlias, accountUsername, token, ... }   (local, no network)
com.palm.accountservices/authenticateAccount   { email, password }      -> signs in: POST authenticateFromDevice, create local profile, save token
com.palm.accountservices/getAggregatedAccountInfo { locale }            -> the OutAccountInfoAggregate the profile view renders
com.palm.accountservices/syncDeviceName        {}                       -> POST assignDeviceName (best-effort), returns the name
com.palm.accountservices/updateUsername        { username }             -> update the handle (local cache + account; server push)
com.palm.accountservices/signOut               {}                       -> POST deauthenticate, clear the local token
```

The request/reply envelopes (`InAuthenticateFromDevice` / `AuthenticateInfoEx`,
`InAccountInfoAggretate` / `OutAccountInfoAggregate`, `InAssignDeviceName`) are
the backend's own, kept verbatim from the community client so LuneOS and webOS CE
share **one** account namespace rather than forking it — the "reuse the community
account" option.

Layout
------

```
service.js            registers both bus names on one process
lib/server.js         the device.php HTTP client (fetch; injectable transport)
lib/handlers.js       the bus methods for both names
lib/device.js         this device's profile + the device/romToken request shapes
lib/store.js          the local token (db8 kind, or in-memory for tests)
lib/nduid.js          /dev/nduid
lib/{bus,palmcall,db,mojo,errors}.js   shared LuneOS node-service runtime
files/sysbus/         ACG api/groups/perm/role, and one .service per bus name
```

Tests
-----

```
npm test            # node --test tests/*.test.js
```

Covered off-device against a stand-in bus and a fake HTTP transport: the device
profile, the whole sign-in path (authenticate → create/rename the local account →
save token), `getAccountToken`, the aggregate fetch with username self-heal, a
backend `JSONException` mapping to a thrown error, `syncDeviceName` (success and
best-effort on server failure), `signOut` (local revoke even when the server
call fails), `updateUsername`, and both bus names answering over the bus.

Grounding / open points
-----------------------

The base URL, method names, request/reply envelopes and local token shape are
taken from webOSArchive's `webos-community-account` client
(`palm_profile_util.js` and the `*CommandAssistant.js` handlers) and its server
docs (`acl-appmall`). The one method whose exact server envelope is not pinned
down from the client is `updateAccountInfo` (used by `updateUsername`): the local
cache and account rename always take, and the server push is best-effort and
self-heals on the next aggregate — confirm the envelope against
`UpdateUsernameCommandAssistant.js` / `UpdateAccountCommandAssistant.js` before
relying on the server side of a rename.

Not yet here (deliberate v1 scope): account creation (`createNovaAccount`),
`isEmailAvailable` / `isUserValid`, security questions and password reset, and
terms-and-conditions — the methods the full sign-*up* flow needs but sign-*in*
and the profile view do not.
