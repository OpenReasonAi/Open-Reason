# Base launch review

## Official integration

The developer portal’s documentation link leads to o1’s official Launchpad API guides. The published OpenAPI 3.1 schema uses `https://api.launch.o1.exchange/v1`. The downloaded specification identified itself as version 1.0.0 and had SHA-256 `6729287b8da26082d4a70c2e692be6d69d3cef925759971f00ba797179ed4de0`. [Developer portal](https://launch.o1.exchange/developers) · [OpenAPI schema](https://docs.o1.exchange/launchpad-api-openapi.yaml)

| Use | Official operation |
| --- | --- |
| Read production availability | `GET /health` and `GET /config` |
| Prepare the unsigned launch | `POST /launches/prepare` |
| Read indexed token, pool, market and holders | `GET /tokens/{chain_id}/{token_address}` and `GET /tokens/{chain_id}/{token_address}/holders` |
| Prepare a creator claim | `POST /claims/fees/prepare` |
| Prepare a treasury buy | `POST /swaps/quote` then `POST /swaps/prepare` |

The API returns unsigned requests for the owner wallet. The agent verifies the Standard factory, hook, fee escrow and Base Universal Router against o1’s published deployment reference. The factory transaction ABI came from Sourcify’s exact runtime match. The Universal Router decoder follows the verified deployed V4 router source and accepts the direct native ETH exact-input, settle-all and take-all sequence only. [Production contracts](https://docs.o1.exchange/launchpad/reference/production-contracts) · [Direct integration](https://docs.o1.exchange/launchpad/integration/direct) · [Factory ABI](https://sourcify.dev/server/v2/contract/8453/0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC?fields=abi) · [Router deployment source](https://sourcify.dev/server/v2/contract/8453/0x6fF5693b99212Da76ad316178A184AB56D299b43?fields=abi,sources)

## Pair proposal

| Quote | Practical implications |
| --- | --- |
| **Native ETH** | Recommended. The same asset funds gas, receives creator-fee payouts and funds the direct treasury buy module. Native input avoids ERC-20 approval. Quote valuations move with ETH. |
| USDC | Registered alongside ETH. A USD-denominated market simplifies reporting. Buyers typically need USDC and ETH for gas. The project’s initial automated preparation for buybacks is scoped to the verified ETH pool. |
| Other Standard crypto assets | o1 lists Coinbase wrapped crypto and Base assets including AERO, MORPHO and BNKR. A separate asset adds conversion and market exposure for a project whose treasury policy is still being established. |
| Stock Tokens | o1 reports 418 registered Base stock quotes from its November 24 snapshot. They introduce an additional stock-market exposure and stock-denominated creator fees. |

The Base factory read at block 61,851,552 returned `launchCreationEnabled = true`, Standard fee 0.001 ETH, configuration version 37 and supply of 1 billion tokens. ETH and native Base USDC were both registered. The catalog and on-chain state are rechecked when building a real launch proposal. Owner approval is required before sending the launch fee or paying transaction gas. [Production contracts and quote catalog](https://docs.o1.exchange/launchpad/reference/production-contracts#uniswap-and-paired-assets) · [Base live configuration](https://docs.o1.exchange/launchpad/reference/live-configuration)

## What remains before launch

- Owner provisions separate hardware-backed EOAs and configures their public addresses, an o1 Launchpad key and the spending caps locally.
- The funded launch wallet passes live API preparation and independent Base simulation. Review metadata on IPFS and the exact transaction from the generated intent.
- The owner signs the approval and transaction. Verify the receipt against the Base safe head before publishing the contract address or enabling market reporting.

The local fixture suite verifies the flow and the approval boundary. A production read verifies the available market and factory state. The project-specific live launch dry run and financial operations require the owner's setup.
