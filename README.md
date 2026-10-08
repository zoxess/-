# GateProof

GateProof is a small-event ticketing prototype focused on verifiable issuance, organizer-approved transfers, revocation, and one-time check-in.

## Current prototype status

- The browser app and API currently run in **local demo mode** because no deployed program ID is configured. Demo state is held in memory and resets when the server restarts.
- When a deployed program ID is configured with `GATEPROOF_PROGRAM_ID`, the browser can connect a Solana wallet and submit create-event, issue, transfer, revoke, and check-in instructions to Devnet. The API verifies the confirmed transaction, expected signer, PDA derivation, and resulting account state before accepting each on-chain action.
- The Solana Anchor program source is in `programs/gateproof`. It has not yet been built or deployed in this workspace.
- No attendee PII is written to the on-chain program. QR values are random demo credentials and must not be used for a real event.

## Run locally

Requires Node.js 20 or later and pnpm.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:4173`.

## Vercel

`vercel.json` sets the Vite build output to `dist`, and `/api/*` requests are routed to the Node.js function in `api/[...path].mjs`.

The API currently keeps events and tickets in process memory. Vercel Functions can restart or serve requests in separate instances, so this deployment is suitable for a visual demo but does not provide durable or shared ticket data. Add a persistent database before relying on it across users or devices.

## Product flow

1. Create a demo event.
2. Issue a QR ticket.
3. Scan the QR on the scanner page; the first scan is accepted and another is rejected.
4. Transfer or revoke a ticket from the organizer view.

## Solana program

The Anchor program stores event configuration and ticket lifecycle state in PDAs. The organizer is the issuer and approves transfers; a configured gate authority can check in a ticket. The QR secret stays off-chain, while its SHA-256 commitment is stored in the ticket PDA. The server checks that a presented QR secret hashes to the commitment and reads the post-transaction account state from Devnet. Keep email, phone, and names off-chain.

Before any Devnet deploy, pin the final program ID in `Anchor.toml` and `programs/gateproof/src/lib.rs`, then build and run the program tests with the matching Anchor, Rust, and Solana toolchains.

## Security and production gaps

This is a hackathon prototype, not production ticket infrastructure. The demo backend keeps its event-to-QR mapping in memory and has no authentication or database. A production version still needs durable storage, organizer and gate authentication, rate limiting, audit/incident handling, key management, QR expiry/rotation, refunds, and operational behavior for venue network outages.
