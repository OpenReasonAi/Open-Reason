import { z } from 'zod';
import { getAddress, isAddress, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';

export const CHAIN = 8453;
export const ETH = zeroAddress;
export const USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
export const FACTORY = getAddress('0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc');
export const HOOK = getAddress('0x1f91c998e7c2f4b690d75bdbf6502bdcd6e02acc');
export const ESCROW = getAddress('0xb3f11a3fb06a88059b7f7f423ec0dda506356866');
export const ROUTER = getAddress('0x6ff5693b99212da76ad316178a184ab56d299b43');
export const POOL_MANAGER = getAddress('0x498581ff718922c3f8e6a244956af099b2652b2b');
export const STATE_VIEW = getAddress('0xa3c0c9b65bad0b08107aa264b0f3db444b867a71');
export const DEAD = getAddress('0x000000000000000000000000000000000000dead');
export const NAME = 'Open Reason';
export const SYMBOL = 'OREN';
export const TAGLINE = 'From thought to execution.';
export const DESCRIPTION = 'Open Reason ($OREN) is an independent AI-driven token project on Base. From thought to execution.';
export const address = z.string().refine(v => isAddress(v), 'Invalid EVM address').transform(v => getAddress(v));
export const nonzero = address.refine(v => v !== ETH, 'A nonzero address is required');
export const hex = z.string().regex(/^0x(?:[\da-fA-F]{2})*$/).transform(v => v.toLowerCase() as Hex);
export const hash = z.string().regex(/^0x[\da-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
export const raw = z.string().max(78).regex(/^(0|[1-9]\d*)$/).refine(v => BigInt(v) < (1n << 256n));
export const positive = raw.refine(v => v !== '0');
export const timestamp = z.iso.datetime({ offset: true });
export const pair = z.enum(['ETH', 'USDC']);
export type Pair = z.infer<typeof pair>;

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function owner(name: 'LAUNCH' | 'TREASURY'): Address {
  const key = `OREN_${name}_OWNER`;
  const result = nonzero.safeParse(process.env[key]);
  requireCondition(result.success, `Set ${key} to the public address of your dedicated wallet`);
  const other = process.env[name === 'LAUNCH' ? 'OREN_TREASURY_OWNER' : 'OREN_LAUNCH_OWNER'];
  requireCondition(!other || nonzero.parse(other) !== result.data, 'Use separate launch and treasury wallets');
  return result.data;
}

export function tokenAddress(): Address {
  const result = nonzero.safeParse(process.env.OREN_TOKEN_ADDRESS);
  requireCondition(result.success, 'Set OREN_TOKEN_ADDRESS only after verifying the successful launch receipt');
  return result.data;
}

export function cap(name: string): bigint {
  const result = positive.safeParse(process.env[name]);
  requireCondition(result.success, `Set ${name} to an owner-selected positive integer`);
  return BigInt(result.data);
}
