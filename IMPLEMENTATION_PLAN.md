# GateProof implementation plan

Product: a wallet-optional ticketing flow for independent event organizers. Solana records ticket lifecycle events; the attendee's identity and QR secret stay off-chain.

## Stages

1. **Product scope and constraints — complete.** Keep the first release to event creation, capped ticket issuance, organizer-approved transfer, revocation, and one-time check-in. Do not collect attendee PII or process payments in the prototype.
2. **Repository and architecture — complete.** Use a small browser app and Node API for the demo, plus an Anchor program for the event and ticket PDAs. Keep the local demo useful before wallet setup or deployment.
3. **Local product flow — complete.** Create an event, issue a QR ticket, transfer/revoke it, and scan it once. Clearly label local in-memory state as a demo.
4. **Solana program and wallet wiring — source implemented; build/deploy pending.** Anchor instructions cover event creation, issuance, gate authority, transfer, revoke, and check-in. The QR secret is committed on-chain as a SHA-256 digest, and the API verifies confirmed Devnet transactions, expected signers, PDA derivation, and resulting account state when the program is configured.
5. **Verification — local checks complete; on-chain checks pending.** The API tests cover QR issuance, transfer invalidation, single-use check-in, capacity, and revocation. Vite production build succeeds. Anchor compilation and program tests still need the official Rust, Solana, and Anchor toolchain.
6. **Devnet demo and handoff — pending.** Build and test the Anchor program; generate and pin its program ID; deploy to Devnet; configure `GATEPROOF_PROGRAM_ID`; verify wallet-backed transactions; capture the demo flow and document the repository setup.

## Current blockers and boundaries

- This Windows environment has Node.js and pnpm, but no Rust, Solana CLI, or Anchor CLI. Anchor's current official setup for Windows uses WSL.
- A Devnet deploy requires a wallet/keypair and Devnet SOL. Do not request or store a seed phrase/private key. Wallet signing and deployment are separate actions that require the user to approve the actual transaction.
- Until stage 6 is complete, the app is a local demo; it does not sell real tickets and must not be presented as a deployed on-chain service.
- Persistent storage and organizer/gate authentication remain required before real tickets.
- The Git remote is `https://github.com/zoxess/-.git`; publishing commits is outside this implementation step.
