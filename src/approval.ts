import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi, parseEventLogs,
  parseTransaction, recoverMessageAddress, recoverTransactionAddress, toHex,
} from 'viem';
import type { Address, Hex, TransactionSerializedEIP1559 } from 'viem';
import { z } from 'zod';
import { baseBlock, escrowAbi, factoryState, simulate, tokenAbi } from './chain.js';
import type { IntentTx, Rpc } from './chain.js';
import { factoryAbi } from './factory-abi.js';
import { brand, checkCalldata, decodeLaunch, launchDetail, launchResult } from './launch.js';
import { CHAIN, DEAD, ESCROW, ETH, FACTORY, NAME, SYMBOL, USDC, address, cap, hash, hex, nonzero,
  owner, positive, raw, requireCondition, timestamp, tokenAddress } from './settings.js';
import { burnDetail, buyDetail, claimDetail, fundingDetail, orenLaunch, purchasedAmount, validateBuyCalldata } from './treasury.js';

const oracle = getAddress('0x420000000000000000000000000000000000000f');
const oracleAbi = parseAbi([
  'function getL1Fee(bytes transaction) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
]);
const claimedAbi = parseAbi(['event Claimed(address indexed recipient, address indexed currency, address indexed destination, uint256 amount)']);
const detailShape = z.discriminatedUnion('kind', [launchDetail, claimDetail, buyDetail, burnDetail, fundingDetail]);
type Detail = z.infer<typeof detailShape>;
const txShape = z.object({ from: nonzero, to: nonzero, data: hex, value: raw });
const bodyShape = z.object({
  version: z.literal(1), chainId: z.literal(CHAIN), expiresAt: timestamp, nonce: z.number().int().nonnegative(),
  simulation: z.object({ block: raw, gas: positive, gasPriceWei: positive, o1Block: raw.optional() }),
  maxNetworkFeeWei: positive, tx: txShape, detail: detailShape,
});
type Body = z.infer<typeof bodyShape>;
const artifact = bodyShape.extend({ digest: hash });
export type Proposal = z.infer<typeof artifact>;
const root = () => resolve('.oren');
const planFile = (id: Hex) => join(root(), 'plans', id + '.json');
const submittedFile = (file: string) => join(root(), 'journal', file + '.json');

export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

function digestOf(data: Body) {
  return keccak256(toHex(JSON.stringify(bodyShape.parse(data))));
}

export function approvalMessage(p: Proposal) {
  return [
    'Open Reason ($OREN) transaction approval',
    `Action: ${p.detail.kind}`,
    `Base Mainnet (${CHAIN})`,
    `From: ${p.tx.from}`,
    `To: ${p.tx.to}`,
    `Value (wei): ${p.tx.value}`,
    `Nonce: ${p.nonce}`,
    `Network fee estimate cap (wei): ${p.maxNetworkFeeWei}`,
    `Expires: ${p.expiresAt}`,
    `Plan digest: ${p.digest}`,
  ].join('\n');
}

async function writePrivate(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, json(value) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function loadProposal(id: Hex): Promise<Proposal> {
  const p = artifact.parse(JSON.parse(await readFile(planFile(id), 'utf8')));
  requireCondition(p.digest === id && p.digest === digestOf(p), 'Proposal digest does not match the stored intent');
  return p;
}

function notExpired(expiresAt: string, chainTime: bigint) {
  const expiry = Date.parse(expiresAt);
  requireCondition(expiry > Date.now() && expiry > Number(chainTime) * 1000, 'Proposal has expired');
}

async function review(rpc: Rpc, block: Awaited<ReturnType<typeof baseBlock>>, tx: IntentTx, detail: Detail) {
  const wallet = owner(detail.kind === 'launch' || detail.kind === 'claim' || detail.kind === 'fund-treasury' ? 'LAUNCH' : 'TREASURY');
  requireCondition(tx.from === wallet, 'Transaction actor differs from the configured operation owner');
  if (detail.kind === 'launch') {
    requireCondition(!process.env.OREN_TOKEN_ADDRESS, 'OREN already has a configured token address');
    const args = decodeLaunch(tx);
    const [state, artwork] = await Promise.all([factoryState(rpc, detail.pairAddress, block.number), brand()]);
    requireCondition((detail.pairAddress === ETH || detail.pairAddress === USDC)
      && state.enabled && state.registered && state.fee.toString() === tx.value
      && state.fee <= cap('OREN_MAX_LAUNCH_FEE_WEI') && state.supply.toString() === detail.totalSupply
      && state.configVersion === args.expectedConfigVersion && state.configVersion.toString() === detail.configVersion
      && args.deadline > block.timestamp && args.quoteToken === detail.pairAddress && !args.metadataEditable
      && args.metadataKeys.length === 0 && args.metadataValues.length === 0
      && args.tokenName === NAME && args.tokenSymbol === SYMBOL && args.tokenContractURI === detail.metadataUri
      && detail.logoHash === artwork.metadata.imageHash && detail.predictedToken.toLowerCase().endsWith('01'),
    'Launch calldata or current factory configuration failed review');
    return;
  }
  if (detail.kind === 'fund-treasury') {
    requireCondition(detail.recipient === owner('TREASURY') && tx.to === detail.recipient && tx.value === detail.amount
      && tx.data === '0x' && BigInt(tx.value) <= cap('OREN_MAX_BUYBACK_WEI')
      && !await rpc.getCode({ address: tx.to, blockNumber: block.number }), 'Unexpected treasury funding destination or amount');
    return;
  }
  requireCondition(detail.token === tokenAddress(), 'Proposal token differs from the verified OREN address');
  const launch = await orenLaunch(rpc, detail.token, owner('LAUNCH'), block.number);
  if (detail.kind === 'claim') {
    requireCondition(launch.feeRecipient === wallet && tx.to === ESCROW && tx.value === '0'
      && (detail.pairAddress === ETH || detail.pairAddress === USDC), 'Unexpected creator fee claim destination or currency');
    checkCalldata(tx.data, encodeFunctionData({ abi: escrowAbi, functionName: 'claimFor', args: [wallet, detail.pairAddress] }));
    const owed = await rpc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'owed',
      args: [wallet, detail.pairAddress], blockNumber: block.number });
    requireCondition(owed >= BigInt(detail.amount), 'Live claimable balance is below the reviewed amount');
  } else if (detail.kind === 'buyback') {
    requireCondition(launch.poolId === detail.poolId && BigInt(detail.amountIn) <= cap('OREN_MAX_BUYBACK_WEI')
      && BigInt(detail.slippageBps) <= cap('OREN_MAX_SLIPPAGE_BPS'), 'Buyback exceeds owner policy or uses the wrong pool');
    validateBuyCalldata(tx, detail, block.timestamp);
  } else {
    const source = await receiptEvidence(rpc, detail.buybackHash);
    requireCondition(source.kind === 'buyback' && source.token === detail.token && source.quantity === detail.amount
      && source.from === wallet && tx.to === detail.token && tx.value === '0', 'Burn does not match a confirmed treasury buyback');
    const data = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [DEAD, BigInt(detail.amount)] });
    requireCondition(tx.data === data, 'Burn calldata changed');
    const balance = await rpc.readContract({ address: detail.token, abi: tokenAbi, functionName: 'balanceOf',
      args: [wallet], blockNumber: block.number });
    requireCondition(balance >= BigInt(detail.amount), 'Treasury OREN balance cannot cover the confirmed buyback amount');
  }
}

function validateCall(detail: Detail, data: Hex) {
  if (detail.kind === 'launch') {
    const result = launchResult(data);
    requireCondition(result.token === detail.predictedToken && result.pool === detail.predictedPool,
      'Independent Base simulation returned a different token or pool');
  } else if (detail.kind === 'burn') {
    requireCondition(decodeFunctionResult({ abi: tokenAbi, functionName: 'transfer', data }), 'OREN transfer returned false');
  }
}

export async function saveProposal(rpc: Rpc, tx: IntentTx, detail: Detail, expiresAt: string, o1Block?: string,
  expectedPool?: Hex) {
  const block = await baseBlock(rpc);
  notExpired(expiresAt, block.timestamp);
  requireCondition(!await rpc.getCode({ address: tx.from, blockNumber: block.number }), 'Use an undelegated hardware-wallet EOA');
  const [simulated, nonce] = await Promise.all([
    simulate(rpc, tx, block.number), rpc.getTransactionCount({ address: tx.from, blockTag: 'pending' }),
  ]);
  if (detail.kind === 'launch') {
    const result = launchResult(simulated.result);
    requireCondition(!expectedPool || expectedPool === result.pool, 'o1 and Base disagree on the predicted pool');
    detail = { ...detail, predictedPool: result.pool };
  }
  await review(rpc, block, tx, detail);
  validateCall(detail, simulated.result);
  const maxNetworkFeeWei = cap('OREN_MAX_NETWORK_FEE_WEI');
  requireCondition(simulated.gas * simulated.gasPrice <= maxNetworkFeeWei, 'Execution gas estimate already exceeds the owner cap');
  notExpired(expiresAt, block.timestamp);
  const data = bodyShape.parse({ version: 1, chainId: CHAIN, expiresAt, nonce, tx, detail,
    maxNetworkFeeWei: maxNetworkFeeWei.toString(), simulation: { block: block.number.toString(),
      gas: simulated.gas.toString(), gasPriceWei: simulated.gasPrice.toString(), o1Block } });
  const p: Proposal = { ...data, digest: digestOf(data) };
  try {
    await writePrivate(planFile(p.digest), p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await loadProposal(p.digest);
  }
  return { proposal: p, approvalMessage: approvalMessage(p), transactionForOfflineSigner: {
    type: '0x2', chainId: CHAIN, nonce, to: tx.to, valueWei: tx.value, data: tx.data, estimatedMinimumGas: p.simulation.gas,
  } };
}

export async function verifyApproval(p: Proposal, signature: Hex) {
  requireCondition(p.digest === digestOf(p), 'Owner approval digest is invalid');
  requireCondition(await recoverMessageAddress({ message: approvalMessage(p), signature }) === p.tx.from,
    'Approval signature does not match the proposal wallet');
}

export async function verifySignedTransaction(p: Proposal, signed: Hex) {
  requireCondition(signed.startsWith('0x02'), 'Offline signature must use EIP-1559 type 2');
  const tx = parseTransaction(signed as TransactionSerializedEIP1559);
  requireCondition(tx.chainId === CHAIN && tx.to && address.parse(tx.to) === p.tx.to
    && (tx.value ?? 0n).toString() === p.tx.value && (tx.data ?? '0x').toLowerCase() === p.tx.data
    && tx.nonce === p.nonce && tx.gas && tx.maxFeePerGas && tx.maxPriorityFeePerGas !== undefined
    && tx.maxPriorityFeePerGas <= tx.maxFeePerGas && !tx.accessList?.length && tx.r && tx.s,
  'Signed transaction differs from the approved chain, nonce, destination, value or calldata');
  requireCondition(await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedEIP1559 }) === p.tx.from,
    'Transaction signature does not match the proposal wallet');
  return { gas: tx.gas, maxFeePerGas: tx.maxFeePerGas };
}

const journalEntry = z.object({ hash, proposal: hash });

async function reserve(file: string, entry: z.infer<typeof journalEntry>) {
  try {
    await writePrivate(submittedFile(file), entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = await readJournal(file);
    requireCondition(previous.hash === entry.hash && previous.proposal === entry.proposal,
      'A different transaction is already reserved. Reconcile the recorded hash before taking further action.');
  }
}

async function readJournal(file: string) {
  return journalEntry.parse(JSON.parse(await readFile(submittedFile(file), 'utf8')));
}

export async function submit(rpc: Rpc, p: Proposal, approval: Hex, signed: Hex) {
  await verifyApproval(p, approval);
  const checked = await verifySignedTransaction(p, signed);
  const block = await baseBlock(rpc);
  notExpired(p.expiresAt, block.timestamp);
  await review(rpc, block, p.tx, p.detail);
  const [simulated, nonce, l1Fee, operatorFee] = await Promise.all([
    simulate(rpc, p.tx, block.number),
    rpc.getTransactionCount({ address: p.tx.from, blockTag: 'pending' }),
    rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'getL1Fee', args: [signed], blockNumber: block.number }),
    rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'getOperatorFee', args: [checked.gas], blockNumber: block.number }),
  ]);
  validateCall(p.detail, simulated.result);
  const networkEstimate = checked.gas * checked.maxFeePerGas + l1Fee + operatorFee;
  requireCondition(nonce === p.nonce && checked.gas >= simulated.gas
    && networkEstimate <= BigInt(p.maxNetworkFeeWei) && networkEstimate <= cap('OREN_MAX_NETWORK_FEE_WEI')
    && simulated.balance >= BigInt(p.tx.value) + networkEstimate, 'Nonce, gas estimate, fee policy or wallet balance changed');
  notExpired(p.expiresAt, block.timestamp);
  const expected = keccak256(signed);
  const entry = { hash: expected, proposal: p.digest };
  if (p.detail.kind === 'launch') await reserve('launch', entry);
  if (p.detail.kind === 'burn') await reserve('burn-' + p.detail.buybackHash, entry);
  await reserve(p.tx.from + '-' + p.nonce, entry);
  await reserve(expected, entry);
  notExpired(p.expiresAt, block.timestamp);
  try {
    requireCondition(await rpc.sendRawTransaction({ serializedTransaction: signed as TransactionSerializedEIP1559 }) === expected, 'RPC returned a different signed hash');
  } catch {
    throw new Error(`Broadcast could not be confirmed. Reconcile the precomputed Base hash ${expected} before retrying.`);
  }
  return { hash: expected, status: 'submitted', estimatedNetworkFeeWei: networkEstimate };
}

export async function receiptEvidence(rpc: Rpc, txHash: Hex) {
  requireCondition(await rpc.getChainId() === CHAIN, 'RPC is not Base Mainnet (8453)');
  const entry = await readJournal(txHash);
  const p = await loadProposal(entry.proposal);
  requireCondition(entry.hash === txHash, 'Receipt journal hash mismatch');
  const [receipt, transaction, safe] = await Promise.all([
    rpc.getTransactionReceipt({ hash: txHash }), rpc.getTransaction({ hash: txHash }), rpc.getBlock({ blockTag: 'safe' }),
  ]);
  requireCondition(receipt.status === 'success' && receipt.blockNumber <= safe.number && receipt.transactionHash === txHash
    && transaction.blockHash === receipt.blockHash && transaction.type === 'eip1559' && transaction.chainId === CHAIN && transaction.nonce === p.nonce
    && getAddress(transaction.from) === p.tx.from && transaction.to && getAddress(transaction.to) === p.tx.to
    && transaction.input.toLowerCase() === p.tx.data && transaction.value.toString() === p.tx.value,
  'Receipt is unconfirmed at the Base safe head, reverted, or differs from the approved transaction');
  const common = { hash: txHash, blockNumber: receipt.blockNumber, from: p.tx.from, to: p.tx.to };
  const detail = p.detail;
  if (detail.kind === 'launch') {
    const [event] = parseEventLogs({ abi: factoryAbi, eventName: 'Launched',
      logs: receipt.logs.filter(x => getAddress(x.address) === FACTORY), strict: true });
    requireCondition(event?.args.token === detail.predictedToken && event.args.poolId === detail.predictedPool
      && event.args.originalCreator === p.tx.from && event.args.quoteToken === detail.pairAddress
      && event.args.launchSupply.toString() === detail.totalSupply, 'Receipt did not emit the exact reviewed launch');
    return { ...common, kind: detail.kind, token: detail.predictedToken, poolId: detail.predictedPool, pairAddress: detail.pairAddress };
  }
  if (detail.kind === 'buyback') {
    const quantity = purchasedAmount(receipt.logs, detail.token, p.tx.from);
    requireCondition(quantity >= BigInt(detail.minimumOut), 'Receipt did not satisfy the reviewed minimum output');
    return { ...common, kind: detail.kind, token: detail.token, quantity: quantity.toString(), paidWei: detail.amountIn };
  }
  if (detail.kind === 'burn') {
    const [event] = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', strict: true,
      logs: receipt.logs.filter(x => getAddress(x.address) === detail.token) });
    requireCondition(event?.args.from === p.tx.from && event.args.to === DEAD && event.args.value.toString() === detail.amount,
      'Receipt did not deliver the approved amount to the dead address');
    return { ...common, kind: detail.kind, token: detail.token, quantity: detail.amount, buybackHash: detail.buybackHash };
  }
  if (detail.kind === 'claim') {
    const [event] = parseEventLogs({ abi: claimedAbi, eventName: 'Claimed', strict: true,
      logs: receipt.logs.filter(x => getAddress(x.address) === ESCROW) });
    requireCondition(event?.args.recipient === p.tx.from && event.args.destination === p.tx.from
      && event.args.currency === detail.pairAddress && event.args.amount >= BigInt(detail.amount),
    'Receipt did not pay the reviewed creator fee claim');
    return { ...common, kind: detail.kind, quantity: event.args.amount.toString(), currency: detail.pairAddress };
  }
  return { ...common, kind: detail.kind, quantity: detail.amount, currency: ETH };
}

export async function signingInput(path: string) {
  requireCondition(basename(path).length > 0, 'Provide a local signing input file');
  return hex.parse((await readFile(path, 'utf8')).trim());
}
