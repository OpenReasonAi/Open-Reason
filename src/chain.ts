import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { base } from 'viem/chains';
import { factoryAbi } from './factory-abi.js';
import { CHAIN, FACTORY, ETH, STATE_VIEW, requireCondition } from './settings.js';

export const escrowAbi = parseAbi([
  'function claimFor(address recipient, address currency)',
  'function owed(address recipient, address currency) view returns (uint256)',
]);
export const tokenAbi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const stateAbi = parseAbi([
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);
export type IntentTx = { from: Address; to: Address; data: Hex; value: string };

export function rpcClient() {
  const url = new URL(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
  requireCondition(url.protocol === 'https:' && !url.username && !url.password, 'BASE_RPC_URL must use HTTPS without URL credentials');
  return createPublicClient({ chain: base, transport: http(url.href, { timeout: 12_000, retryCount: 1 }) });
}
export type Rpc = ReturnType<typeof rpcClient>;

export async function baseBlock(rpc: Rpc) {
  requireCondition(await rpc.getChainId() === CHAIN, 'RPC is not Base Mainnet (8453)');
  return rpc.getBlock({ blockTag: 'latest' });
}

export async function factoryState(rpc: Rpc, quote: Address, blockNumber: bigint) {
  const params = { address: FACTORY, abi: factoryAbi, blockNumber } as const;
  const [enabled, fee, configVersion, supply, [registered, decimals, startingTick]] = await Promise.all([
    rpc.readContract({ ...params, functionName: 'launchCreationEnabled' }),
    rpc.readContract({ ...params, functionName: 'nativeLaunchFee' }),
    rpc.readContract({ ...params, functionName: 'configVersion' }),
    rpc.readContract({ ...params, functionName: 'launchSupply' }),
    rpc.readContract({ ...params, functionName: 'quoteConfig', args: [quote] }),
  ]);
  return { enabled, fee, configVersion, supply, registered, decimals, startingTick };
}

export async function liquidity(rpc: Rpc, poolId: Hex, blockNumber: bigint) {
  const [activeLiquidity, [sqrtPriceX96, tick, protocolFee, lpFee]] = await Promise.all([
    rpc.readContract({ address: STATE_VIEW, abi: stateAbi, functionName: 'getLiquidity', args: [poolId], blockNumber }),
    rpc.readContract({ address: STATE_VIEW, abi: stateAbi, functionName: 'getSlot0', args: [poolId], blockNumber }),
  ]);
  return { blockNumber, activeLiquidity, sqrtPriceX96, tick, protocolFee, lpFee };
}

export async function simulate(rpc: Rpc, tx: IntentTx, blockNumber: bigint) {
  const args = { account: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) } as const;
  const [call, gas, balance] = await Promise.all([
    rpc.call({ ...args, blockNumber }),
    rpc.estimateGas({ ...args, blockNumber }),
    rpc.getBalance({ address: tx.from, blockNumber }),
  ]);
  const gasPrice = await rpc.getGasPrice();
  requireCondition(gas > 0n && gasPrice > 0n, 'Base RPC produced an invalid gas estimate');
  requireCondition(balance >= args.value + gas * gasPrice, 'Wallet balance cannot cover transaction value plus estimated execution gas');
  return { result: call.data ?? '0x', gas, gasPrice, balance } as const;
}

export async function originalLaunch(rpc: Rpc, token: Address, launchOwner: Address, blockNumber: bigint) {
  const [rights, name, symbol] = await Promise.all([
    rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'creatorRights', args: [token], blockNumber }),
    rpc.readContract({ address: token, abi: tokenAbi, functionName: 'name', blockNumber }),
    rpc.readContract({ address: token, abi: tokenAbi, functionName: 'symbol', blockNumber }),
  ]);
  requireCondition(getAddress(rights.originalCreator) === launchOwner && rights.originalCreator !== ETH,
    'Token was not created by the configured launch wallet on the verified factory');
  return { poolId: rights.poolId, feeRecipient: getAddress(rights.creatorFeeRecipient), name, symbol };
}
