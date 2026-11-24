import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256,
  parseAbi, parseAbiParameters, toHex } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { approvalMessage, loadProposal, saveProposal, submit, verifyApproval, verifySignedTransaction } from '../src/approval.js';
import type { Rpc } from '../src/chain.js';
import { factoryAbi } from '../src/factory-abi.js';
import { brand, checkCalldata, decodeLaunch, launchResult, prepareLaunch } from '../src/launch.js';
import { O1, oneTransaction, plan } from '../src/o1.js';
import { CHAIN, ETH, ESCROW, FACTORY, HOOK, ROUTER, USDC, positive } from '../src/settings.js';
import { makeBurn, validateBuyCalldata } from '../src/treasury.js';

const launchWallet = privateKeyToAccount(generatePrivateKey());
const treasury = privateKeyToAccount(generatePrivateKey());
const token = getAddress('0xeebb000000000000000000000000000000000001');
const pool = toHex(13, { size: 32 });
const now = BigInt(Math.floor(Date.now() / 1000));
const expiry = new Date(Date.now() + 120_000).toISOString();
const suite = 'base-mainnet-rwa-timestamp-v4';
const args = { tokenName: 'Open Reason', tokenSymbol: 'OREN', tokenContractURI: 'ipfs://examplefixture',
  creatorSalt: toHex(1337, { size: 32 }), quoteToken: ETH, expectedConfigVersion: 15n, deadline: now + 120n,
  metadataEditable: false, metadataKeys: [], metadataValues: [] };
const data = encodeFunctionData({ abi: factoryAbi, functionName: 'createLaunch', args: [args] });
const tx = { from: launchWallet.address, to: FACTORY, data, value: '1000000000000000' };
const apiStep = { id: 'launch', kind: 'transaction', depends_on: [], simulation: { status: 'succeeded' }, transaction: {
  chain_id: CHAIN, ...tx,
} };
const prepared = { chain_id: CHAIN, actor: launchWallet.address, expires_at: expiry, observed_block: '10', issues: [],
  steps: [apiStep], suite_id: suite, metadata_uri: args.tokenContractURI,
  predicted_token_address: token, creation_fee: { amount_raw: tx.value, currency_address: ETH },
  review: { market: 'standard', token: { name: 'Open Reason', symbol: 'OREN', editable_metadata: false, extra_metadata: [] },
    total_supply_raw: '100', pool_supply_raw: '100', quote_address: ETH, pool_id: pool } };

function fixtureRpc(effects: { broadcasts: number; nonce?: number; result?: Hex; gas?: bigint }) {
  const rpc = {
    getChainId: async () => CHAIN,
    getBlock: async () => ({ number: 10n, timestamp: now }),
    getCode: async () => undefined,
    getBalance: async () => 10_000_000_000_000_000n,
    getGasPrice: async () => 1n,
    estimateGas: async () => effects.gas ?? 100_000n,
    call: async () => ({ data: effects.result ?? encodeFunctionResult({ abi: factoryAbi,
      functionName: 'createLaunch', result: [token, pool] }) }),
    getTransactionCount: async () => effects.nonce ?? 7,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case 'launchCreationEnabled': return true;
        case 'nativeLaunchFee': return BigInt(tx.value);
        case 'configVersion': return 15n;
        case 'launchSupply': return 100n;
        case 'quoteConfig': return [true, args?.[0] === ETH ? 18 : 6, -10000];
        case 'getL1Fee': return 500n;
        case 'getOperatorFee': return 0n;
        default: throw new Error('Unexpected fixture read');
      }
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      effects.broadcasts++;
      return keccak256(serializedTransaction);
    },
  };
  return rpc as unknown as Rpc;
}

test('metadata includes original PNG and fixed project identity', async () => {
  const { metadata, logo } = await brand();
  assert.equal(metadata.symbol, 'OREN');
  assert.equal(metadata.imageType, 'image/png');
  assert.equal(logo.readUInt32BE(16), 512);
  assert.equal(logo.readUInt32BE(20), 512);
  assert.equal(metadata.imageHash, keccak256(toHex(logo)));
});

test('approved API step requires exact chain, actor, expiry, dependencies and simulation', () => {
  assert.deepEqual(oneTransaction(plan.parse(prepared), launchWallet.address), tx);
  assert.throws(() => oneTransaction(plan.parse({ ...prepared, actor: treasury.address }), launchWallet.address));
  assert.throws(() => oneTransaction(plan.parse({ ...prepared, expires_at: new Date(0).toISOString() }), launchWallet.address), /expired/);
  for (const step of [{ ...apiStep, simulation: { status: 'not_run' } }, { ...apiStep, depends_on: ['approval'] }]) {
    assert.throws(() => oneTransaction(plan.parse({ ...prepared, steps: [step] }), launchWallet.address));
  }
  assert.throws(() => plan.parse({ ...prepared, chain_id: 1 }));
  assert.throws(() => oneTransaction(plan.parse({ ...prepared,
    issues: [{ code: 'balance', severity: 'blocking' }] }), launchWallet.address));
});

test('only exact plain launch and recognized builder suffix can be decoded', () => {
  assert.deepEqual(decodeLaunch(tx), args);
  assert.throws(() => decodeLaunch({ ...tx, to: ROUTER }), /verified/);
  assert.throws(() => checkCalldata(`${data}deadbeef`, data));
  assert.doesNotThrow(() => checkCalldata(`${data}00026f3180218021802180218021802180218021`, data));
  assert.deepEqual(launchResult(encodeFunctionResult({ abi: factoryAbi, functionName: 'createLaunch',
    result: [token, pool] })), { token, pool });
});

test('launch integration uses live catalog and pins the committed PNG in a plain prepare request', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.launch.o1.exchange');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'test-only');
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/v1/config') {
      return Response.json({ meta: { generated_at: expiry }, data: {
        chain: { chain_id: CHAIN, capabilities: { b20_asset_status: 'active' } },
        suites: [{ id: suite, chain_id: CHAIN, creation_available: true, contracts: { factory: FACTORY, hook: HOOK, fee_escrow: ESCROW } }],
        quotes: [{ address: ETH, suite_id: suite, symbol: 'ETH', decimals: 18, registered: true, selectable: true, route: 'standard' },
          { address: USDC, suite_id: suite, symbol: 'USDC', decimals: 6, registered: true, selectable: true, route: 'standard' }],
      } });
    }
    assert.equal(url.pathname, '/v1/launches/prepare');
    assert.equal(headers.get('idempotency-key'), 'test-idempotency');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.creator, launchWallet.address);
    assert.equal(request.quote_address, ETH);
    assert.equal(request.dev_buy, undefined);
    assert.equal(request.token.editable_metadata, false);
    assert.equal(request.token.image_base64, (await brand()).logo.toString('base64'));
    return Response.json({ data: prepared });
  };
  const result = await prepareLaunch(new O1('test-only', fetcher), fixtureRpc({ broadcasts: 0 }),
    launchWallet.address, 'ETH', 10n ** 16n, 'test-idempotency');
  assert.equal(result.detail.predictedToken, token);
  assert.equal(result.expectedPool, pool);
});

test('read operations distinguish missing API access and never print a response body', async () => {
  const sensitive = 'not-a-real-secret';
  const fetcher: typeof fetch = async () => new Response(sensitive, { status: 401 });
  await assert.rejects(new O1(undefined, fetcher).config(), /O1_API_KEY/);
  await assert.rejects(new O1(sensitive, fetcher).config(), { message: 'o1 /config returned HTTP 401' });
  const health = new O1(undefined, async (_, init) => {
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    return Response.json({ status: 'ok', api_version: 'v1', build_id: 'fixture', time: expiry });
  });
  assert.equal((await health.health()).status, 'ok');
});

test('buyback validation binds pool, exact amount, fee-bearing command and recipient', () => {
  const key = { currency0: ETH, currency1: token, fee: 0x800000, tickSpacing: 200, hooks: HOOK };
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters(
    '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) pool'), [key]));
  const buy = { kind: 'buyback' as const, token, poolId, amountIn: '50', minimumOut: '20', slippageBps: 50 };
  const swap = encodeAbiParameters(parseAbiParameters(
    '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData) swap'),
  [{ poolKey: key, zeroForOne: true, amountIn: 50n, amountOutMinimum: 20n, hookData: '0x' }]);
  const encode = (target = token, commands: Hex = '0x10') => {
    const amountAbi = parseAbiParameters('address currency, uint256 amount');
    const call = encodeAbiParameters(parseAbiParameters('bytes actions,bytes[] inputs'), ['0x060c0f',
      [swap, encodeAbiParameters(amountAbi, [ETH, 50n]), encodeAbiParameters(amountAbi, [target, 20n])]]);
    return encodeFunctionData({ abi: parseAbi(['function execute(bytes, bytes[], uint256) payable']),
      args: [commands, [call], now + 50n] });
  };
  const buyTx = { from: treasury.address, to: ROUTER, data: encode(), value: '50' };
  assert.equal(validateBuyCalldata(buyTx, buy, now), now + 50n);
  assert.throws(() => validateBuyCalldata({ ...buyTx, data: encode(USDC) }, buy, now));
  assert.throws(() => validateBuyCalldata({ ...buyTx, data: encode(token, '0x90') }, buy, now));
  assert.throws(() => validateBuyCalldata(buyTx, { ...buy, minimumOut: '21' }, now));
  assert.throws(() => validateBuyCalldata(buyTx, buy, now + 51n));
});

test('burn transaction targets the project token and amount, and raw values preserve precision', () => {
  const result = makeBurn(treasury.address, token, pool, 10n ** 30n);
  assert.equal(result.tx.to, token);
  assert.equal(result.tx.value, '0');
  assert.equal(result.detail.amount, '1000000000000000000000000000000');
  assert.match(result.tx.data, /000000000000000000000000000000000000dead/);
  assert.throws(() => makeBurn(treasury.address, token, pool, 0n));
  assert.throws(() => positive.parse('01'));
  assert.throws(() => positive.parse('1e18'));
});

test('dry-run proposal, EIP-191 approval and matching offline signer gate the only broadcaster', async () => {
  const start = process.cwd();
  const temp = await mkdtemp(join(tmpdir(), 'oren-tests-'));
  const keys = { OREN_LAUNCH_OWNER: launchWallet.address, OREN_TREASURY_OWNER: treasury.address,
    OREN_MAX_LAUNCH_FEE_WEI: '2000000000000000', OREN_MAX_NETWORK_FEE_WEI: '1000000', OREN_TOKEN_ADDRESS: undefined };
  const saved = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(temp);
  try {
    const effects: { broadcasts: number; nonce?: number } = { broadcasts: 0 };
    const rpc = fixtureRpc(effects);
    const detail = { kind: 'launch' as const, pairAddress: ETH, predictedToken: token,
      predictedPool: pool, metadataUri: args.tokenContractURI, totalSupply: '100', configVersion: '15',
      logoHash: (await brand()).metadata.imageHash };
    const alternate = getAddress('0xaaaa000000000000000000000000000000000001');
    await assert.rejects(saveProposal(rpc, tx, { ...detail, predictedToken: alternate }, expiry), /different token or pool/);
    const outcome = await saveProposal(rpc, tx, detail, expiry);
    const p = await loadProposal(outcome.proposal.digest);
    assert.equal(effects.broadcasts, 0);

    const signature = await launchWallet.signMessage({ message: approvalMessage(p) });
    const invalid = await treasury.signMessage({ message: approvalMessage(p) });
    const requested = { chainId: CHAIN, type: 'eip1559' as const, to: tx.to, nonce: p.nonce,
      value: BigInt(tx.value), data, gas: 101_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    const signed = await launchWallet.signTransaction(requested);
    await assert.rejects(verifyApproval({ ...p, tx: { ...p.tx, value: '0' } }, signature), /digest/);
    await assert.rejects(submit(rpc, p, invalid, signed), /Approval signature/);
    await assert.rejects(verifySignedTransaction(p, await treasury.signTransaction(requested)), /Transaction signature/);
    await assert.rejects(verifySignedTransaction(p, await launchWallet.signTransaction({ ...requested, chainId: 1 })), /differs/);
    await assert.rejects(verifySignedTransaction(p, await launchWallet.signTransaction({ ...requested, value: 0n })), /differs/);
    await assert.rejects(verifySignedTransaction(p, await launchWallet.signTransaction({ ...requested, data: '0x' })), /differs/);
    await assert.rejects(submit(rpc, p, signature, await launchWallet.signTransaction({ ...requested, maxFeePerGas: 10n })), /fee policy/);
    effects.nonce = 8;
    await assert.rejects(submit(rpc, p, signature, signed), /Nonce/);
    assert.equal(effects.broadcasts, 0);
    effects.nonce = 7;
    const submitted = await submit(rpc, p, signature, signed);
    assert.equal(submitted.hash, keccak256(signed));
    assert.equal(effects.broadcasts, 1);
    const replacement = await launchWallet.signTransaction({ ...requested, maxFeePerGas: 3n });
    await assert.rejects(submit(rpc, p, signature, replacement), /already reserved/);
    assert.equal(effects.broadcasts, 1);
  } finally {
    process.chdir(start);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
