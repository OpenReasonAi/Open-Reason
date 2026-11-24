import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z, ZodError } from 'zod';
import { approvalMessage, json, loadProposal, receiptEvidence, saveProposal, signingInput, submit } from './approval.js';
import { baseBlock, factoryState, rpcClient } from './chain.js';
import { brand, pairs, prepareLaunch } from './launch.js';
import { report, snapshot, verifiedToken, walletBalances } from './monitor.js';
import { O1 } from './o1.js';
import { ETH, USDC, cap, hash, owner, pair, positive, requireCondition, tokenAddress } from './settings.js';
import { makeBurn, prepareBuyback, prepareClaim } from './treasury.js';

const usage = `Open Reason agent
  doctor
  metadata
  pairs
  wallet-check
  prepare launch [--pair ETH|USDC] [--idempotency-key UUID]
  prepare claim
  prepare fund-treasury --amount-wei RAW
  prepare buyback --amount-wei RAW --slippage-bps BPS
  prepare burn --tx-hash BUYBACK_HASH
  approval-message PLAN_DIGEST
  submit PLAN_DIGEST --approval-file PATH --signed-tx-file PATH
  receipt TX_HASH
  monitor [--interval SECONDS]
  report [--tx-hash HASH ...]`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    pair: { type: 'string' }, 'idempotency-key': { type: 'string' }, 'amount-wei': { type: 'string' },
    'slippage-bps': { type: 'string' }, 'tx-hash': { type: 'string', multiple: true },
    'approval-file': { type: 'string' }, 'signed-tx-file': { type: 'string' }, interval: { type: 'string' },
  } });
  if (!cmd || cmd === 'help' || cmd === '--help') return usage;
  if (cmd === 'metadata') return json((await brand()).metadata);
  if (cmd === 'approval-message') return approvalMessage(await loadProposal(hash.parse(positionals[0])));

  const rpc = rpcClient();
  const o1 = new O1();
  if (cmd === 'doctor') {
    const [health, block] = await Promise.all([o1.health(), baseBlock(rpc)]);
    const [eth, usdc] = await Promise.all([factoryState(rpc, ETH, block.number), factoryState(rpc, USDC, block.number)]);
    return json({ health, chainId: 8453, block: block.number, eth, usdc });
  }
  if (cmd === 'pairs') return json(await pairs(o1, rpc));
  if (cmd === 'wallet-check') {
    const balances = await walletBalances(rpc, { launch: owner('LAUNCH'), treasury: owner('TREASURY') },
      process.env.OREN_TOKEN_ADDRESS ? tokenAddress() : undefined);
    requireCondition(balances.wallets.every(w => w.undelegatedEoa), 'Use separate undelegated hardware-wallet EOAs');
    return json(balances);
  }
  if (cmd === 'receipt') return json(await receiptEvidence(rpc, hash.parse(positionals[0])));
  if (cmd === 'submit') {
    const [id] = positionals;
    requireCondition(values['approval-file'] && values['signed-tx-file'], 'Provide both local signature files');
    const [p, approval, signed] = await Promise.all([
      loadProposal(hash.parse(id)), signingInput(values['approval-file']), signingInput(values['signed-tx-file']),
    ]);
    requireCondition(signed.startsWith('0x02'), 'A signed EIP-1559 transaction is required');
    return json(await submit(rpc, p, approval, signed));
  }
  if (cmd === 'prepare') {
    const [action] = positionals;
    const actionExpiry = () => new Date(Date.now() + 10 * 60_000).toISOString();
    if (action === 'launch') {
      requireCondition(!process.env.OREN_TOKEN_ADDRESS, 'OREN already has a configured token address');
      const key = values['idempotency-key'] ? z.uuid().parse(values['idempotency-key']) : randomUUID();
      process.stderr.write(`Launch preparation idempotency key: ${key}\n`);
      const result = await prepareLaunch(o1, rpc, owner('LAUNCH'), pair.parse(values.pair ?? 'ETH'), cap('OREN_MAX_LAUNCH_FEE_WEI'), key);
      // saveProposal replaces the provisional pool from the API with its own independently simulated value.
      return json(await saveProposal(rpc, result.tx, { ...result.detail, predictedPool: result.expectedPool ?? `0x${'0'.repeat(64)}` },
        result.expiresAt, result.apiBlock, result.expectedPool));
    }
    if (action === 'claim') {
      const launchOwner = owner('LAUNCH');
      const token = tokenAddress();
      const verified = await verifiedToken(o1, rpc, token, launchOwner);
      requireCondition(verified.launch.feeRecipient === launchOwner, 'The dedicated launch wallet is not the current fee recipient');
      const result = await prepareClaim(o1, launchOwner, token, verified.quote);
      return json(await saveProposal(rpc, result.tx, result.detail, result.expiresAt, result.apiBlock));
    }
    if (action === 'fund-treasury') {
      const amount = positive.parse(values['amount-wei']);
      const recipient = owner('TREASURY');
      return json(await saveProposal(rpc, { from: owner('LAUNCH'), to: recipient, value: amount, data: '0x' },
        { kind: 'fund-treasury', recipient, amount }, actionExpiry()));
    }
    if (action === 'buyback') {
      const amount = positive.parse(values['amount-wei']);
      const bps = z.coerce.number().int().min(1).max(4999).parse(values['slippage-bps']);
      requireCondition(BigInt(amount) <= cap('OREN_MAX_BUYBACK_WEI') && BigInt(bps) <= cap('OREN_MAX_SLIPPAGE_BPS'),
        'Buyback exceeds owner spend or slippage cap');
      const result = await prepareBuyback(o1, rpc, owner('TREASURY'), owner('LAUNCH'), tokenAddress(), amount, bps);
      return json(await saveProposal(rpc, result.tx, result.detail, result.expiresAt, result.apiBlock));
    }
    if (action === 'burn') {
      const txHash = hash.parse(values['tx-hash']?.[0]);
      const source = await receiptEvidence(rpc, txHash);
      requireCondition(source.kind === 'buyback' && source.token === tokenAddress()
        && source.from === owner('TREASURY'), 'Provide a confirmed buyback from this treasury');
      const burn = makeBurn(source.from, source.token, txHash, BigInt(source.quantity));
      return json(await saveProposal(rpc, burn.tx, burn.detail, actionExpiry()));
    }
  }
  if (cmd === 'monitor' || cmd === 'report') {
    const sample = () => snapshot(o1, rpc, tokenAddress(), owner('LAUNCH'), owner('TREASURY'));
    if (cmd === 'report') {
      const hashes = [...new Set((values['tx-hash'] ?? []).map(value => hash.parse(value)))];
      const [data, evidence] = await Promise.all([sample(), Promise.all(hashes.map(txHash => receiptEvidence(rpc, txHash)))]);
      return report(data, evidence);
    }
    if (!values.interval) return json(await sample());
    const seconds = z.coerce.number().int().min(1).parse(values.interval);
    while (true) {
      try {
        console.log(JSON.stringify(JSON.parse(json(await sample()))));
      } catch {
        console.error('Monitor sample failed. Retrying on the next interval.');
      }
      await setTimeout(seconds * 1_000);
    }
  }
  throw new Error(usage);
}

try {
  const result = await main();
  if (result !== undefined) console.log(result);
} catch (e) {
  // RPC errors can contain URLs and request details. Only print locally defined messages.
  if (e instanceof ZodError) console.error('Invalid or missing input. Check the command arguments and .env settings.');
  else if (e instanceof Error && e.constructor === Error) console.error(e.message);
  else console.error('Operation failed. Check local files, Base RPC availability, and transaction simulation status.');
  process.exitCode = 1;
}
