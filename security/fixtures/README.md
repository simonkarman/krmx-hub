# Test fixtures (SECURITY-TEST-PLAN §3)

Checked-in RSA keypairs for the local security harness only — never for any
real deployment.

- `ticket-signing-key.pem` — injected as `TICKET_PRIVATE_KEY` into the hub
  that global-setup boots, so tests can also craft tokens signed with the
  "real" hub key (expiry, aud, tamper cases).
- `attacker-key.pem` — never given to the hub; used to forge tokens that
  must be rejected (T-03).
