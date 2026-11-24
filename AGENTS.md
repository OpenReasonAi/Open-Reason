# Open Reason agent instructions

- Preserve Open Reason ($OREN) as an independent project. Use Node.js and TypeScript without an OpenAI API key or claims of affiliation.
- Treat o1’s official OpenAPI, verified Base contracts, and an independently checked Base RPC as the integration sources. Verify revisions before trusting changed contracts or transaction shapes. Record disagreements as blockers.
- Public wallet addresses are allowed. Keep keys, mnemonics, signed transactions, approvals, RPC credentials and o1 API keys out of Git, logs, tickets, chat and public reports.
- Preparation and monitoring are read-only on Base. Do not call the broadcaster during a dry run or use a wallet with delegated signing authority.
- Each launch, claim, transfer, buyback or burn requires fresh simulation and the human owner's explicit authorization for that specific transaction. No scheduled, autonomous or blanket approval. A failed, ambiguous or expired transaction requires reconciliation.
- Do not create artificial volume, wash trades, coordinated price activity or trades designed to move the market. Keep buyback amounts and slippage inside owner policy and keep claims, funding, buybacks and burns separately approved.
- For launch, verify the exact factory, quote, metadata, owner, value, block and deadline. Launch only after live dry-run success and owner approval. Report a token address as deployed only after the Base safe-head receipt and matching factory event.
- Use receipt evidence for fee claims, treasury transfers, buys and dead-address transfers. Identify unconfirmed, stale or unavailable data. Keep public updates in draft until the owner approves publishing.
- Run `npm test`, `npm audit`, `npm run agent -- doctor` and inspect any new production integration before committing. Tests use in-process fixtures and never broadcast to Base.
