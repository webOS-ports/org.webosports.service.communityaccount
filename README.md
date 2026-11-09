org.webosports.service.communityaccount
=======================================

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
                                                                           (a wrong e-mail or password: errorCode AUTH_FAILED)
com.palm.accountservices/createNovaAccount     { email, password, firstName, lastName? }
                                                                        -> signs up and in: POST createDeviceAccount, then as authenticateAccount
                                                                           (errorCode INVALID_EMAIL, WEAK_PASSWORD, EMAIL_TAKEN, ... as the server sends it)
com.palm.accountservices/isEmailAvailable      { email }                -> { available }: POST isEmailAvailable
com.palm.accountservices/getTermsAndConditions {}                       -> { terms }: the server's terms of service as plain text (lib/terms.js)
com.palm.accountservices/getAggregatedAccountInfo { locale }            -> the OutAccountInfoAggregate the profile view renders
com.palm.accountservices/syncDeviceName        {}                       -> POST assignDeviceName (best-effort), returns the name
com.palm.accountservices/updateUsername        { username }             -> POST updateUsername; once the server takes it, the local cache + account
com.palm.accountservices/updateAccountInfo     { firstName, lastName? } -> POST updateAccountInfo: the display name (profile editor's NAME row)
com.palm.accountservices/changeEmail           { email }                -> POST changeEmailAddress; once the server takes it, the kept alias
                                                                           (errorCode PAMS1005 not an address, PAMS1008 in use, PAMS1123 the same one)
com.palm.accountservices/changePassword        { newPassword }          -> POST changePassword (WEAK_PASSWORD below 8 bytes); this device stays signed in
                                                                           All three authenticate with the kept token only, never one the caller passes.
com.palm.accountservices/signOut               {}                       -> POST deauthenticate (revokes the token on the server), clear the local token
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
lib/terms.js          the server's terms of service, HTML to plain text
lib/device.js         this device's profile + the device/romToken request shapes
lib/store.js          the local token (db8 kind, or in-memory for tests)
lib/nduid.js          the platform nduId: /dev/nduid, then nyx (as woce-backup)
lib/deviceid.js       the id the server sees: HMAC of the nduId under a key of this device
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

The base URL, method names and request/reply envelopes are checked against the
server itself: `WebService/device.php` in webOSArchive's `webos-catalog-service`
(read 2026-11-09), with the community client (`webos-community-account`) for the
names the device side used. `tests/server-shapes.test.js` holds the bridge to
what device.php sends: an error is `{"JSONException": "<CODE>"}` at HTTP 200, a
wrong password `{"authFailed": true}`, a new account an `AuthenticateInfoEx` as
a sign-in. Reading it found three things the client-derived code had wrong: the
error code was read from an object the server never sends, so every error came
out as the caller's generic code; `signOut` put the token in an envelope
`deauthenticate` does not read, so the token was never revoked on the server;
and `updateUsername` went to `updateAccountInfo`, which only sets the display
name.

Not here: `isUserValid` (a password re-check the profile editor no longer
needs), security questions (the server stores none), a forgotten-password reset (the server has
none; its `changePassword` needs a signed-in device), e-mail
verification (the server has none; an account works at once), and erasing an
account (the server has no method for it; its terms point to
appcatalog.webosarchive.org/admin).
