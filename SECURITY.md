Security & GDPR review — com.palm.service.communityaccount
==========================================================

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
  token store.
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

Residual risks (tracked)
------------------------

1. **Token at rest in db8** — stored unencrypted; readable by a caller with db8
   access to that kind. Matches legacy behaviour. **v2:** move the token into
   keymanager (encrypted at rest) and keep only a handle in db8.
2. **No certificate pinning** — relies on the system trust store. Acceptable;
   pinning is a **v3** consideration given the endpoint may rotate certs.
3. **`updateAccountInfo` envelope not pinned** — the server push on a username
   change is best-effort and self-heals on the next aggregate; confirm the
   envelope before relying on the server side (see README "Grounding").

GDPR
----

- **Personal data handled**: account email (alias), username/display name, and
  device identifiers (nduId, and serial/model where present) sent to the backend
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
- **Right to erasure / withdrawal**: `signOut` calls `deauthenticate`
  (server-side revoke, best-effort) and clears the local token; a future
  account-deletion method (`dissociateCurrentDevice`/erase) would complete it
  and is a tracked v2/v3 sign-up-flow item.
- **No analytics or telemetry** in the bridge.
