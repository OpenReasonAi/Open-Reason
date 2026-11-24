import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { z } from 'zod';
import { baseBlock, escrowAbi, liquidity, tokenAbi } from './chain.js';
import type { Rpc } from './chain.js';
import type { O1 } from './o1.js';
import { CHAIN, DEAD, ESCROW, ETH, FACTORY, HOOK, NAME, SYMBOL, USDC, address, hash, nonzero,
  raw, requireCondition, timestamp } from './settings.js';
import { orenLaunch } from './treasury.js';

const price = z.object({ quote: z.number().nullable(), usd: z.number().nullable() });
const indexed = z.object({
  chain_id: z.literal(CHAIN), market: z.literal('standard'),
  token: z.object({ address: nonzero, name: z.literal(NAME), symbol: z.literal(SYMBOL) }),
  launch: z.object({
    pool_id: hash, quote: z.object({ address, decimals: z.number().int().nonnegative().nullable() }),
    contracts: z.object({ factory_address: nonzero, fee_escrow_address: nonzero, hook_address: nonzero }),
  }),
  market_data: z.object({
    price, market_cap: price, liquidity: price, activity: z.object({ '24h': z.object({
      trades: z.number().int().nullable(), volume_quote_raw: raw.nullable(), volume_usd: z.number().nullish(),
    }) }).passthrough(),
    fee_revenue: z.array(z.object({ currency_address: address, creator_raw: raw }).passthrough()),
    data_status: z.enum(['fresh', 'syncing', 'partial', 'stale']),
    observed_block: z.number().int().nullable(), confirmed_block: z.number().int().nullable(),
    updated_at: timestamp.nullable(),
  }).nullish(),
});
const holder = z.object({ address, balance_raw: raw, supply_percent: z.number().min(0).max(100).optional() });
const summary = z.object({
  status: z.literal('ready'), total_holders: z.number().int().nonnegative(), top_10_percent: z.number().min(0).max(100).nullable(),
});

export async function verifiedToken(o1: O1, rpc: Rpc, token: Address, launchOwner: Address) {
  const block = await baseBlock(rpc);
  const [launch, index] = await Promise.all([
    orenLaunch(rpc, token, launchOwner, block.number),
    o1.get(`/tokens/${CHAIN}/${token}?include=pool,market`, indexed),
  ]);
  const onchain = index.data.launch;
  requireCondition(index.data.token.address === token && onchain.pool_id === launch.poolId
    && onchain.contracts.factory_address === FACTORY && onchain.contracts.fee_escrow_address === ESCROW
    && onchain.contracts.hook_address === HOOK, 'Indexed token contracts disagree with the verified launch');
  const quote = onchain.quote.address;
  const decimals = quote === ETH ? 18 : 6;
  requireCondition((quote === ETH || quote === USDC) && onchain.quote.decimals === decimals, 'Unexpected OREN quote identity');
  return { block, launch, index, quote, decimals, symbol: quote === ETH ? 'ETH' : 'USDC' };
}

export async function walletBalances(rpc: Rpc, wallets: { launch: Address; treasury: Address }, token?: Address) {
  const block = await baseBlock(rpc);
  const data = await Promise.all(Object.entries(wallets).map(async ([role, wallet]) => {
    const [native, code, oren] = await Promise.all([
      rpc.getBalance({ address: wallet, blockNumber: block.number }),
      rpc.getCode({ address: wallet, blockNumber: block.number }),
      token ? rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf',
        args: [wallet], blockNumber: block.number }) : null,
    ]);
    return { role, wallet, ethWei: native, orenRaw: oren, undelegatedEoa: !code };
  }));
  return { block: block.number, wallets: data };
}

export async function snapshot(o1: O1, rpc: Rpc, token: Address, launchOwner: Address, treasury: Address) {
  const verified = await verifiedToken(o1, rpc, token, launchOwner);
  const { block, launch, index, quote, decimals, symbol } = verified;
  const contracts = { address: token, abi: tokenAbi, blockNumber: block.number } as const;
  const [pool, ownerOwed, supply, deadBalance, launchEth, treasuryEth, treasuryOren, holders] = await Promise.all([
    liquidity(rpc, launch.poolId, block.number),
    rpc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'owed', args: [launch.feeRecipient, quote], blockNumber: block.number }),
    rpc.readContract({ ...contracts, functionName: 'totalSupply' }),
    rpc.readContract({ ...contracts, functionName: 'balanceOf', args: [DEAD] }),
    rpc.getBalance({ address: launchOwner, blockNumber: block.number }),
    rpc.getBalance({ address: treasury, blockNumber: block.number }),
    rpc.readContract({ ...contracts, functionName: 'balanceOf', args: [treasury] }),
    o1.get(`/tokens/${CHAIN}/${token}/holders?limit=10`, z.array(holder)).then(result => ({
      status: summary.parse(result.summary), generatedAt: result.meta.generated_at, largest: result.data,
    })).catch(() => null),
  ]);
  return {
    token, pair: symbol, quoteDecimals: decimals, block: block.number, blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    poolId: launch.poolId, liquidity: pool, market: index.data.market_data ?? null,
    marketGeneratedAt: index.meta.generated_at, holders, supply, deadBalance,
    creatorFees: { recipient: launch.feeRecipient, escrow: ESCROW, claimableRaw: ownerOwed,
      indexedLifetimeRaw: index.data.market_data?.fee_revenue.find(fee => fee.currency_address === quote)?.creator_raw ?? null,
      scope: 'All credits to this recipient, escrow, and currency' },
    treasury: { launchWallet: launchOwner, launchEth, treasuryWallet: treasury, treasuryEth, treasuryOren },
  };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Evidence = Awaited<ReturnType<typeof import('./approval.js').receiptEvidence>>;

export function report(data: Snapshot, receipts: Evidence[]) {
  const display = (input: number | null | undefined) => input == null ? 'Unavailable' : input.toString();
  return [
    '# Open Reason transparency update', '', `Base Mainnet snapshot at block ${data.block} on ${data.blockTime}.`, '',
    `- Contract [${data.token}](https://basescan.org/token/${data.token})`,
    `- Market OREN/${data.pair}, pool \`${data.poolId}\``,
    `- Indexed market status ${data.market?.data_status ?? 'unavailable'} as of ${data.market?.updated_at ?? data.marketGeneratedAt}`,
    `- Indexed price (USD) ${display(data.market?.price.usd)} and liquidity (USD) ${display(data.market?.liquidity.usd)}`,
    `- Indexed market cap (USD) ${display(data.market?.market_cap.usd)} and 24-hour trades ${display(data.market?.activity['24h'].trades)}`,
    `- Indexed 24-hour volume (USD) ${display(data.market?.activity['24h'].volume_usd)}`,
    `- Active Uniswap v4 liquidity (raw) ${data.liquidity.activeLiquidity}`,
    `- Indexed holders ${display(data.holders?.status.total_holders)} and share of top ten (%) ${display(data.holders?.status.top_10_percent)}`,
    `- ERC-20 total supply ${formatUnits(data.supply, 18)} OREN and dead address balance ${formatUnits(data.deadBalance, 18)} OREN`,
    `- Indexed lifetime creator fees for this token ${data.creatorFees.indexedLifetimeRaw === null ? 'Unavailable' : formatUnits(BigInt(data.creatorFees.indexedLifetimeRaw), data.quoteDecimals) + ' ' + data.pair}`,
    `- Creator escrow balance ${formatUnits(data.creatorFees.claimableRaw, data.quoteDecimals)} ${data.pair}, aggregated by receiver, escrow and currency`,
    `- Treasury balance ${formatUnits(data.treasury.treasuryEth, 18)} ETH and ${formatUnits(data.treasury.treasuryOren, 18)} OREN`,
    '', '## Verified transactions', '',
    ...(receipts.length ? receipts.map(e => `- ${e.kind} at block ${e.blockNumber}${'quantity' in e ? `, raw amount ${e.quantity}` : ''} [BaseScan](https://basescan.org/tx/${e.hash})`)
      : ['No transaction hashes were supplied for this reporting period.']),
    '', 'Open Reason is an independent project. From thought to execution.', '',
  ].join('\n');
}
