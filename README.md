# Open Reason ($OREN)

![Open Reason mark](assets/logo.png)

**From thought to execution.**

Open Reason is an independent AI-driven token project. This TypeScript agent prepares and monitors its planned Base Mainnet launch on o1 Exchange. It runs on Node.js 24 or newer and uses no OpenAI API credentials. Open Reason has no affiliation with OpenAI.

**Launch proposal** — Standard B20, OREN/ETH, with the fixed supply seeded into the o1 Uniswap v4 pool, editable metadata disabled and no developer buy. USDC is supported as a launch option. The buyback module takes native ETH into the verified OREN/ETH launch pool. See [the launch review](docs/launch-review.md).

## Start locally

```sh
npm ci --ignore-scripts
npm test
npm run agent -- doctor
npm run agent -- metadata
```

`doctor` checks o1 production health, the Base chain ID and the Standard factory’s ETH and USDC registration, supply, fee and creation status without an API key. `metadata` displays the fixed project identity and a hash of the PNG.

Copy `.env.example` to `.env` on the operator machine and restrict access with `chmod 600 .env`. Configure the two public wallet addresses and owner-selected caps. Keep `OREN_TOKEN_ADDRESS` empty until a confirmed launch receipt identifies the contract. Use a dedicated o1 Launchpad API key with the scopes appropriate to the command.

| Operation | o1 scopes |
| --- | --- |
| Pair catalog | `config:read` |
| Launch preparation | `config:read`, `launches:prepare` |
| Monitoring and reports | `tokens:read` |
| Creator claim preparation | `tokens:read`, `claims:prepare` |
| Buyback preparation | `swaps:quote`, `swaps:prepare` |

The API key stays on the operator machine. The signer needs only the reviewed approval text and the unsigned transaction fields. Use separate scoped credentials for standing monitoring and temporary preparation. [o1 Developer portal](https://launch.o1.exchange/developers) · [o1 API documentation](https://docs.o1.exchange/launchpad/api/introduction)

## Wallet setup

1. On hardware wallets or separately controlled hardware-wallet accounts, create a dedicated launch EOA and a separate treasury EOA. Back up recovery phrases offline and verify both addresses on the signing device. Only the two public addresses go into the agent config.
2. Run `npm run agent -- wallet-check` to read the Base balances, verify the accounts are distinct and check that neither address has a contract or delegation. Keep the signing devices with the owner.
3. The launch signer pays the creation fee and receives the creator position. The treasury signer performs any separately approved buyback or burn. Fund either account only after reviewing the address and Base chain in the sending wallet. A live launch simulation needs enough ETH to cover the current creation fee and estimated gas.

## Prepare and approve a launch

```sh
npm run agent -- pairs
npm run agent -- prepare launch --pair ETH
```

Preparing calls the official unsigned API. o1 can pin the committed image and the public metadata on IPFS during preparation. The agent resolves the live suite and quote, decodes the exact factory call, checks the fee and supply, simulates on Base with `eth_call`, and estimates gas. It checks the returned token and pool against o1’s review. The digest, observed blocks, nonce, expiry and review are saved in `.oren/plans/`. The CLI prints the launch idempotency key to stderr. A transient retry can reuse that key with the same wallet, metadata and pair. An expired plan requires a fresh key, simulation and approval.

For any prepared financial action:

1. Inspect the complete proposal and its decoded operation. For a launch, also verify the pinned metadata and image against the PNG hash and intended public profile. A predicted address is for review until the receipt verifies it.
2. Save the exact output of `node dist/src/cli.js approval-message PLAN_DIGEST` as the text to sign. Remove its final terminal newline. The owner signs the UTF-8 text using EIP-191 personal signing.
3. In the same hardware wallet sign the exact transaction fields as an EIP-1559 Base transaction. Set gas limit at or above the simulated minimum, and choose max fee and priority fee within the owner’s network-fee estimate cap. The agent supports signers that can export raw signed transactions. Foundry’s [cast wallet sign](https://www.getfoundry.sh/reference/cast/wallet/sign) and [cast mktx](https://www.getfoundry.sh/reference/cast/mktx) document hardware-wallet signing and raw transaction creation. Verify your device supports both operations before funding the launch account.
4. Put the two hex signatures in private local files under `.oren/`. Keep the signed raw transaction private because it is broadcastable. Explicitly request the broadcast from the operator machine.

```sh
npm run agent -- submit PLAN_DIGEST --approval-file .oren/approval.hex --signed-tx-file .oren/signed.hex
npm run agent -- receipt TRANSACTION_HASH
```

`submit` verifies both signatures, their exact owner and transaction envelope, nonce, expiry, fee caps and a fresh Base simulation. It journals the precomputed signed hash before broadcasting. The network cap is a preflight estimate using signed gas limits and current L1 and operator fee estimates. L1 pricing can change before inclusion. The receipt command verifies the exact transaction, Base safe head and relevant event. Set `OREN_TOKEN_ADDRESS` to the verified contract from the successful `launch` receipt only.

If broadcast is ambiguous, reconcile the precomputed hash using `receipt` or BaseScan before attempting another transaction. The private journal reserves one launch and one burn per confirmed buyback. Keep a private backup. Reconcile a stale reservation against the Base safe head and sender nonce before archiving it. A previously signed transaction can be replayed while its nonce and on-chain deadline are valid. Ordinary ETH transfers, claims and token transfers have no contract-level expiry, so the owner must protect their signed bytes and check the nonce before replacing a transaction.

## Treasury and monitoring

| Command | Result |
| --- | --- |
| `prepare claim` | Simulated claim of the configured owner’s fees in the verified quote currency. |
| `prepare fund-treasury --amount-wei RAW` | Simulated capped ETH transfer from the launch owner to the separate treasury. |
| `prepare buyback --amount-wei RAW --slippage-bps BPS` | Exact-input quote and a simulated, capped treasury transaction for the ETH-paired Standard pool. |
| `prepare burn --tx-hash BUYBACK_HASH` | A separate simulated transfer of the verified buyback proceeds to the dead address. |
| `monitor` or `monitor --interval 60` | Read-only market, holder, pool, fee and treasury snapshots. |
| `report --tx-hash HASH` | Markdown transparency draft with current data and supplied verified receipt evidence. Repeat `--tx-hash` for multiple receipts. |

Prepend `npm run agent --` to each command. A buyback does not submit a burn. A transfer to the dead address is reported separately from ERC-20 total supply. An escrow claim covers a wallet, escrow and quote currency and can include fee credits from other activity. The report labels the token-specific indexed creator fee total separately. A report is generated locally for review. Missing or stale index data retain their status.

[Operational rules](AGENTS.md) · [Production verification and pair analysis](docs/launch-review.md) · [Public update drafts](docs/public-updates.md)
