import { readFile } from 'node:fs/promises';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { factoryAbi } from './factory-abi.js';
import { baseBlock, factoryState } from './chain.js';
import type { IntentTx, Rpc } from './chain.js';
import { O1, oneTransaction, plan } from './o1.js';
import { CHAIN, DESCRIPTION, ETH, ESCROW, FACTORY, HOOK, NAME, SYMBOL, TAGLINE, USDC, address, hash,
  nonzero, positive, raw, requireCondition } from './settings.js';
import type { Pair } from './settings.js';

const imagePath = new URL('../../assets/logo.png', import.meta.url);
const builderSuffix = '80218021802180218021802180218021';
export function checkCalldata(full: Hex, canonical: Hex) {
  if (full === canonical.toLowerCase()) return;
  const suffix = full.slice(canonical.length);
  requireCondition(full.startsWith(canonical.toLowerCase()) && suffix.length <= 512
    && suffix.endsWith(builderSuffix), 'Calldata is non-canonical or has unrecognized attribution');
}

export const launchDetail = z.object({
  kind: z.literal('launch'), pairAddress: address, predictedToken: nonzero, predictedPool: hash,
  metadataUri: z.string().regex(/^ipfs:\/\/[A-Za-z0-9]+(?:\/[A-Za-z0-9._/-]+)?$/),
  logoHash: hash, totalSupply: positive, configVersion: raw,
});
export type LaunchDetail = z.infer<typeof launchDetail>;

const response = plan.extend({
  predicted_token_address: nonzero, suite_id: z.string(), metadata_uri: launchDetail.shape.metadataUri,
  requires_reprepare: z.boolean().optional(),
  creation_fee: z.object({ amount_raw: raw, currency_address: address }).optional(),
  review: z.object({
    market: z.literal('standard'), launch_product: z.literal('non-tax').optional(),
    pool_supply_raw: positive, total_supply_raw: positive, quote_address: address,
    config_version: raw.optional(),
    pool_id: hash.optional(),
    token: z.object({ name: z.literal(NAME), symbol: z.literal(SYMBOL), editable_metadata: z.literal(false),
      extra_metadata: z.array(z.unknown()).length(0) }),
  }),
});

export async function brand() {
  const logo = await readFile(imagePath);
  requireCondition(logo.length <= 2_000_000 && logo.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    'The project logo must be a PNG within o1 upload limits');
  return { logo, metadata: { name: NAME, symbol: SYMBOL, description: DESCRIPTION, tagline: TAGLINE,
    imageType: 'image/png', imageHash: keccak256(toHex(logo)), editableMetadata: false } };
}

export async function pairs(o1: O1, rpc: Rpc) {
  const [config, block] = await Promise.all([o1.config(), baseBlock(rpc)]);
  const suite = config.suites.find(s => s.contracts.factory === FACTORY && s.contracts.hook === HOOK
    && s.contracts.fee_escrow === ESCROW && s.creation_available);
  requireCondition(suite && config.chain.capabilities.b20_asset_status === 'active',
    'o1 configuration does not admit the reviewed Standard Base factory and B20 feature');
  const checks = await Promise.all([ETH, USDC].map(async asset => ({
    asset, ...(await factoryState(rpc, asset, block.number)),
  })));
  return { suite: suite.id, block: block.number, recommended: 'ETH' as const,
    available: config.quotes.filter(q => q.suite_id === suite.id && q.registered && q.selectable), checks };
}

export function decodeLaunch(tx: IntentTx) {
  requireCondition(tx.to === FACTORY, 'Launch target is not the verified o1 Standard factory');
  const decoded = decodeFunctionData({ abi: factoryAbi, data: tx.data });
  requireCondition(decoded.functionName === 'createLaunch', 'Only a plain createLaunch is supported');
  const [args] = decoded.args;
  checkCalldata(tx.data, encodeFunctionData({ abi: factoryAbi, functionName: 'createLaunch', args: [args] }));
  return args;
}

export function launchResult(result: Hex) {
  const [token, pool] = decodeFunctionResult({ abi: factoryAbi, functionName: 'createLaunch', data: result });
  return { token: nonzero.parse(token), pool: hash.parse(pool) };
}

export async function prepareLaunch(o1: O1, rpc: Rpc, actor: Address, selected: Pair,
  maxFee: bigint, key: string) {
  const [catalog, { logo, metadata }] = await Promise.all([pairs(o1, rpc), brand()]);
  const asset = selected === 'ETH' ? ETH : USDC;
  const state = catalog.checks.find(item => item.asset === asset)!;
  requireCondition(state.enabled && state.registered && state.fee <= maxFee
    && catalog.available.some(q => q.address === asset && q.route === 'standard' && q.decimals === state.decimals),
    'Selected quote or creation fee failed the live Base checks');
  const prepared = await o1.post('/launches/prepare', response, {
    chain_id: CHAIN, creator: actor, market: 'standard', launch_product: 'non-tax', quote_address: asset,
    token: { name: NAME, symbol: SYMBOL, description: DESCRIPTION, image_base64: logo.toString('base64'),
      image_type: 'image/png', editable_metadata: false, extra_metadata: [] },
  }, key);
  requireCondition(!prepared.requires_reprepare && prepared.suite_id === catalog.suite
    && prepared.review.quote_address === asset && prepared.review.pool_supply_raw === prepared.review.total_supply_raw,
    'o1 launch review did not match the intended factory, asset, and full pool supply');
  requireCondition(!prepared.creation_fee || prepared.creation_fee.currency_address === ETH,
    'Expected a native-only creation fee');
  const tx = oneTransaction(prepared, actor);
  const args = decodeLaunch(tx);
  requireCondition(tx.value === (prepared.creation_fee?.amount_raw ?? '0'),
    'Transaction value differs from the reviewed creation fee');
  // Only the independent Base eth_call establishes the resulting pool and token.
  return { tx, expiresAt: prepared.expires_at, apiBlock: prepared.observed_block,
    expectedPool: prepared.review.pool_id, detail: {
      kind: 'launch' as const, pairAddress: asset, predictedToken: prepared.predicted_token_address,
      metadataUri: prepared.metadata_uri, logoHash: metadata.imageHash,
      totalSupply: prepared.review.total_supply_raw, configVersion: args.expectedConfigVersion.toString(),
    } };
}
