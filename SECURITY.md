Security & GDPR review — org.webosports.service.communityaccount
================================================================

Scope: the identity bridge (lib/*, service.js) as written on 2026-11-08,
reviewed for security hardening and GDPR. It signs the device in to the webOS
Community Account backend and serves the local token to other apps.

Trust boundaries
----------------

1. **Bus callers** reach the bridge only through the ACG role/permissions in
   `files/sysbus/` (`com.palm.accountservices.*`, `com.palm.deviceprofile.*`).
2. **The account server** (`appcatalog.webosarchive.org`) is a third party
   reached over TLS. Its replies are untrusted input (`asResult` validates
   them); a `JSONException` body — which the backend returns even at HTTP 200 —
   is mapped to a thrown, coded error rather than a silent success.

Handling of secrets
-------------------

- **Password** — transits only. `authenticateAccount` forwards it to the
  backend and **never stores it**; it is not written to db8, disk, or logs.
- **Bearer token** — stored locally in db8
  (`com.palm.account.palmprofiletoken:1`) so `getAccountToken` can serve it to
  other apps without a network round-trip. This mirrors the legacy palmprofile
  token store. The kind is owned by the bridge's own appId, so db8 lets no
  other app read it directly (checked on a device: another caller's `find` is
  "permission denied"). A db8 call that fails is reported with the token
  shown as `<hidden>`. db8 itself still logs the payload of a call it refuses,
  so a save that fails puts the token in the journal; the store's id and owner
  are what db8 accepts, so a save should not fail.
- **Fixed before release:** the first device builds never saved the token: db8
  refused the kind (owned by `com.palm.accountservices`, not the caller) and
  the id (`_palmprofiletoken`, too long). Every sign-in failed after the
  server had issued a token, and that token was logged.
- **Sign-up password** — as the sign-in one: forwarded to `createDeviceAccount`
  and never stored. A too-short one is refused before anything is sent, and the
  refusal does not echo it.
- **Changed password** (`changePassword`, the Accounts app's profile editor) —
  the same: forwarded to `changePassword` with the kept token and never stored;
  a too-short one is refused here without echoing it. The token sent is always
  the one this service keeps, never one the caller passes (the app sends its
  own copy as `idToken`, which is ignored), so a caller cannot make the bridge
  act on another account's token. The server leaves this device's token valid.
- **No secret is logged.** `server.js` logs method names, not bodies; `bus.js`
  logs the method and caller, not the payload; `palmcall.js` redacts
  `password`/`keydata`/`credentials` from any bus-failure text. The hardening
  test asserts the password never appears in a thrown error.

Hardening applied 2026-11-08
----------------------------

- **TLS enforced** — `createServer` refuses a non-`https:` base when using the
  real transport, so credentials can never go out in cleartext.
- **No credential-forwarding on redirect** — the default fetch uses
  `redirect: 'error'`, so a 30x cannot forward the password/token POST to
  another origin.
- **Bounded reply** — the response is rejected past 1 MiB (declared or actual),
  and every request is abort-timed (30 s), so a hung or runaway endpoint cannot
  wedge or exhaust the service.
- **Upsert, not duplicate** — sign-in renames the single local palmprofile
  account rather than creating parallel rows, so there is one identity to erase.

Found on a device and fixed 2026-11-09
--------------------------------------

- **The role never applied** — `run-js-service -n` gives the process its
  directory name (`org.webosports.service.communityaccount`) as appId, and the
  role and client permissions were keyed `com.palm.accountservices`, so the
  service died on start ("Invalid permissions"). The role now carries the
  real appId; `tests/sysbus.test.js` ties it to the `.service` Exec directory.
- **Client permissions keyed by the wrong name** — the same change re-keyed
  the client permissions by that appId alone. The hub takes a service's
  required groups by the bus name it calls from, so the bridge was left with
  only "public" and every call it made was refused (`createAccount`,
  `listAccounts`, `deviceInfo/query`). A sign-up made the account on the
  server and then reported a failure. They are keyed by both bus names again
  (and the appId).
- **No stack traces in replies** — `mojo.js` put the error's stack in the
  `exception` field of every error reply, handing any caller the service's
  paths and code layout. It now carries the error's name and message only; the
  stack goes to the device log. (The same copy in app-services' accounts
  service and contacts linker still does this.)
- **The device is not named by its hardware** — see "Device identifier" below.
- **Sign-out did not revoke the token on the server** — `deauthenticate`
  reads the token at the top level and answers success for any token, and
  the bridge sent it inside an `InDeauthenticate` envelope, so a signed-out
  device's token stayed valid on the server for its year. Found by reading
  device.php; `tests/server-shapes.test.js` now holds every envelope to it.
- **No serial number or MAC address is sent** — `getDeviceParams` sends them as
  `""` whatever the platform reports. (It read `serialNumber`, which LuneOS
  happens not to set, so none had gone out.)

Device identifier
-----------------

The platform nduId (`lib/nduid.js`: `/dev/nduid`, then `nyx-cmd DeviceInfo
query nduid`, as woce-backup reads it) is not sent. On Halium it is an
unsalted `SHA1(ro.serialno)`, and the serial is on the box and shown by adb:
anyone who has it could compute the id the server holds and find the device
and its account. On mainline (PinePhone, PinePhone Pro, PineTab2) nyx makes a
random one, which is better but still the same id every local consumer sees.

The server gets `HMAC-SHA1(key, "org.webosports.service.communityaccount/
device-id\0" + nduId)` instead (`lib/deviceid.js`), 40 hex characters as
before. The key is 32 random bytes made on the device the first time, in
`/var/lib/org.webosports.service.communityaccount/device-id.key` (0600, in a
0700 directory, read with O_NOFOLLOW and checked to be a regular file of the
right size). Without the key the id cannot be worked out from the serial or the
nduId; devices without an nduId still get ids of their own. It stays the same
across reboots and updates and changes after a data wipe, when the server sees
a new device. `getDeviceProfile` answers with the same id, so the Accounts
app's "this device" matches the server's list; woce-backup keeps naming
manifests after the platform nduId, which never leaves the device.

Residual risks (tracked)
------------------------

1. **Token at rest in db8** — stored unencrypted; readable by a caller with db8
   access to that kind. Matches legacy behaviour. **v2:** move the token into
   keymanager (encrypted at rest) and keep only a handle in db8.
2. **No certificate pinning** — relies on the system trust store. Acceptable;
   pinning is a **v3** consideration given the endpoint may rotate certs.
3. **No e-mail verification or captcha at sign-up** — the server makes an
   account active at once and limits only by IP (240 device.php calls an hour).
   Anyone can sign up with an address that is not theirs. Server-side; noted
   for webOSArchive.

GDPR
----

- **Personal data handled**: account email (alias), username/display name, and
  a device identifier (the derived account device id, not the platform nduId;
  no serial number or MAC address) and the device name and model sent to the backend
  for sign-in and the account's device-list feature; email + username + token
  cached locally in db8.
- **Lawful basis**: consent — the whole flow is **user-initiated** sign-in.
  First Use must keep it optional and skippable.
- **Data minimisation**: only the fields the feature needs are sent; several
  device fields are empty on LuneOS and sent as `""` rather than fabricated.
- **Transfer**: data goes to the webOSArchive-operated backend (a third party,
  possibly a third country). This is inherent to "reuse the community account";
  it belongs in the user-facing privacy note and, if LuneOS operates alongside
  it, a processor/DPA arrangement — outside this code's control.
- **Pseudonymisation**: the device id the backend holds is keyed with a secret
  that never leaves the device, so it cannot be linked to the hardware by
  anyone holding the serial; wiping the device breaks the link for good.
- **Sign-up** (`createNovaAccount`): the e-mail address, first and last name
  and the password go to the server, which stores the address, a display name
  ("first last") and a password hash, and keeps this device's account id,
  model and OS version with the sign-in token. The terms First Use shows
  (`getTermsAndConditions`, as plain text) are the server's own; the server
  records no acceptance.
- **Right to erasure / withdrawal**: `signOut` calls `deauthenticate`
  (server-side revoke) and clears the local token. Erasing the account itself
  has no device.php method; the server's terms point to
  appcatalog.webosarchive.org/admin, where a member can delete their stored
  data, and deleting the account is done by its administrators.
- **No analytics or telemetry** in the bridge.
