import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress,
  keccak256, parseAbi, parseAbiParameters, parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { baseBlock, escrowAbi, originalLaunch, tokenAbi } from './chain.js';
import type { IntentTx, Rpc } from './chain.js';
import { checkCalldata } from './launch.js';
import { O1, cleanSteps, oneTransaction, plan } from './o1.js';
import { CHAIN, DEAD, ESCROW, ETH, HOOK, NAME, POOL_MANAGER, ROUTER, SYMBOL, address, hash, nonzero,
  positive, raw, requireCondition, timestamp } from './settings.js';

export const claimDetail = z.object({
  kind: z.literal('claim'), token: nonzero, pairAddress: address, amount: positive,
});
export const buyDetail = z.object({
  kind: z.literal('buyback'), token: nonzero, poolId: hash, amountIn: positive, minimumOut: positive,
  slippageBps: z.number().int().min(1).max(4999),
});
export const burnDetail = z.object({
  kind: z.literal('burn'), token: nonzero, buybackHash: hash, amount: positive,
});
export const fundingDetail = z.object({ kind: z.literal('fund-treasury'), recipient: nonzero, amount: positive });

const claimResponse = plan.extend({ review: z.object({ claims: z.array(z.object({
  kind: z.literal('fee'), recipient: nonzero, destination: nonzero, fee_escrow: nonzero,
  currency: address, claimable_raw: positive, step_id: z.string(),
})).length(1) }) });
const swapReview = z.object({
  token_address: nonzero, side: z.literal('buy'), input_currency: z.literal(ETH), output_currency: nonzero,
  amount_in_raw: positive, slippage_bps: z.number().int().min(1).max(4999),
});
const quoteResponse = z.object({
  chain_id: z.literal(CHAIN), quote_id: z.string().min(1), expires_at: timestamp, minimum_out_raw: positive,
  review: swapReview, issues: plan.shape.issues, steps: z.array(z.unknown()).length(0),
});
const swapResponse = plan.extend({
  minimum_out_raw: positive,
  review: swapReview.extend({ reviewed_minimum_out_raw: positive, execution_minimum_out_raw: positive }),
});
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const actionArgs = parseAbiParameters('bytes actions, bytes[] inputs');
const amounts = parseAbiParameters('address currency, uint256 amount');
const swapArgs = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData) swap',
);
const poolArgs = parseAbiParameters('(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) pool');

export async function orenLaunch(rpc: Rpc, token: Address, launchOwner: Address, blockNumber: bigint) {
  const launch = await originalLaunch(rpc, token, launchOwner, blockNumber);
  requireCondition(launch.name === NAME && launch.symbol === SYMBOL && launch.poolId !== `0x${'0'.repeat(64)}`,
    'Token identity or originating pool could not be verified');
  return launch;
}

export function validateBuyCalldata(tx: IntentTx, detail: z.infer<typeof buyDetail>, chainTime: bigint) {
  requireCondition(tx.to === ROUTER && tx.value === detail.amountIn, 'Buyback target or ETH value differs from the review');
  const { args } = decodeFunctionData({ abi: routerAbi, data: tx.data });
  const [commands, inputs, deadline] = args;
  checkCalldata(tx.data, encodeFunctionData({ abi: routerAbi, functionName: 'execute', args }));
  requireCondition(deadline > chainTime && commands === '0x10' && inputs.length === 1, 'Unexpected Universal Router command or deadline');
  const [actions, steps] = decodeAbiParameters(actionArgs, inputs[0]!);
  requireCondition(actions === '0x060c0f' && steps.length === 3
    && encodeAbiParameters(actionArgs, [actions, steps]) === inputs[0], 'Unexpected Uniswap V4 buyback actions');
  const [swap] = decodeAbiParameters(swapArgs, steps[0]!);
  const settle = decodeAbiParameters(amounts, steps[1]!);
  const take = decodeAbiParameters(amounts, steps[2]!);
  const [payCurrency, paymentMax] = settle;
  const [receiveCurrency, receiveMin] = take;
  requireCondition(encodeAbiParameters(swapArgs, [swap]) === steps[0]
    && encodeAbiParameters(amounts, settle) === steps[1] && encodeAbiParameters(amounts, take) === steps[2],
    'Non-canonical buyback action calldata');
  requireCondition(keccak256(encodeAbiParameters(poolArgs, [swap.poolKey])) === detail.poolId
    && swap.poolKey.hooks === HOOK && swap.poolKey.currency0 === ETH && swap.poolKey.currency1 === detail.token
    && swap.zeroForOne && swap.amountIn.toString() === detail.amountIn
    && swap.amountOutMinimum.toString() === detail.minimumOut && /^0x0*$/.test(swap.hookData)
    && payCurrency === ETH && paymentMax.toString() === detail.amountIn
    && receiveCurrency === detail.token && receiveMin.toString() === detail.minimumOut,
    'Buyback calldata failed pool, spend, recipient or minimum-output checks');
  return deadline;
}

export async function prepareBuyback(o1: O1, rpc: Rpc, actor: Address, launchOwner: Address,
  token: Address, amountIn: string, slippageBps: number) {
  const block = await baseBlock(rpc);
  const launch = await orenLaunch(rpc, token, launchOwner, block.number);
  const request = { chain_id: CHAIN, wallet: actor, token_address: token, side: 'buy',
    amount_in_raw: amountIn, slippage_bps: slippageBps };
  const quote = await o1.post('/swaps/quote', quoteResponse, request);
  cleanSteps(quote.issues);
  const matches = (r: z.infer<typeof swapReview>) => r.token_address === token && r.output_currency === token
    && r.amount_in_raw === amountIn && r.slippage_bps === slippageBps;
  requireCondition(matches(quote.review) && Date.parse(quote.expires_at) > Date.now(), 'Buyback quote changed or expired');
  const prepared = await o1.post('/swaps/prepare', swapResponse, { quote_id: quote.quote_id, wallet: actor });
  requireCondition(matches(prepared.review) && prepared.review.reviewed_minimum_out_raw === quote.minimum_out_raw
    && prepared.review.execution_minimum_out_raw === prepared.minimum_out_raw
    && BigInt(prepared.minimum_out_raw) >= BigInt(quote.minimum_out_raw), 'Buyback preparation weakened the reviewed price floor');
  const tx = oneTransaction(prepared, actor);
  const detail = { kind: 'buyback' as const, token, poolId: launch.poolId, amountIn,
    minimumOut: prepared.minimum_out_raw, slippageBps };
  validateBuyCalldata(tx, detail, block.timestamp);
  return { tx, detail, expiresAt: prepared.expires_at, apiBlock: prepared.observed_block };
}

export async function prepareClaim(o1: O1, actor: Address, token: Address, pairAddress: Address) {
  const prepared = await o1.post('/claims/fees/prepare', claimResponse, { chain_id: CHAIN, caller: actor,
    claims: [{ recipient: actor, fee_escrow: ESCROW, currency: pairAddress, mode: 'to_recipient' }] });
  const claim = prepared.review.claims[0]!;
  requireCondition(claim.recipient === actor && claim.destination === actor && claim.fee_escrow === ESCROW
    && claim.currency === pairAddress && claim.step_id === prepared.steps[0]?.id, 'Fee claim changed payout intent');
  return { tx: oneTransaction(prepared, actor), detail: { kind: 'claim' as const, token, pairAddress,
    amount: claim.claimable_raw }, expiresAt: prepared.expires_at, apiBlock: prepared.observed_block };
}

export function makeBurn(actor: Address, token: Address, buybackHash: Hex, amount: bigint) {
  requireCondition(amount > 0n, 'Buyback did not deliver any OREN');
  const tx = { from: actor, to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer',
    args: [DEAD, amount] }), value: '0' };
  return { tx, detail: { kind: 'burn' as const, token, buybackHash, amount: amount.toString() } };
}

export function purchasedAmount(logs: Parameters<typeof parseEventLogs>[0]['logs'], token: Address, buyer: Address) {
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer',
    logs: logs.filter(log => getAddress(log.address) === token), strict: true });
  const incoming = transfers.filter(x => x.args.to === buyer);
  requireCondition(incoming.length === 1 && incoming[0]?.args.from === POOL_MANAGER
    && !transfers.some(x => x.args.from === buyer), 'Receipt has no unambiguous OREN payout from the launch pool manager');
  return incoming[0].args.value;
}
