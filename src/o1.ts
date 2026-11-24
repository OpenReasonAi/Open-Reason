import { z } from 'zod';
import { CHAIN, address, hex, nonzero, raw, timestamp, requireCondition } from './settings.js';

const origin = 'https://api.launch.o1.exchange/v1';
const tx = z.object({ chain_id: z.literal(CHAIN), from: nonzero, to: nonzero, data: hex, value: raw });
const issue = z.object({ code: z.string(), severity: z.enum(['blocking', 'action_required', 'warning']) });
const step = z.object({
  id: z.string(), kind: z.enum(['transaction', 'typed_data']), depends_on: z.array(z.string()),
  transaction: tx.optional(), simulation: z.object({ status: z.enum(['succeeded', 'not_run']) }).optional(),
});
export const plan = z.object({
  chain_id: z.literal(CHAIN), actor: nonzero, expires_at: timestamp, observed_block: raw,
  issues: z.array(issue), steps: z.array(step),
});

export function cleanSteps(issues: z.infer<typeof issue>[]) {
  requireCondition(issues.every(i => i.severity === 'warning'), 'o1 returned blocking issues or required wallet prerequisites');
}

export function oneTransaction(data: z.infer<typeof plan>, actor: string) {
  cleanSteps(data.issues);
  const [step] = data.steps;
  requireCondition(data.actor === actor && data.steps.length === 1 && step?.kind === 'transaction'
    && step.transaction?.from === actor && step.depends_on.length === 0
    && step.simulation?.status === 'succeeded', 'Expected one successful independent o1 simulation for your wallet');
  requireCondition(Date.parse(data.expires_at) > Date.now(), 'o1 preparation expired');
  const { from, to, data: calldata, value } = step.transaction;
  return { from, to, data: calldata, value };
}

export const configuration = z.object({
  chain: z.object({ chain_id: z.literal(CHAIN), capabilities: z.object({ b20_asset_status: z.string() }) }),
  suites: z.array(z.object({
    id: z.string(), chain_id: z.literal(CHAIN), creation_available: z.boolean(),
    contracts: z.object({ factory: nonzero, hook: nonzero, fee_escrow: nonzero.optional() }),
  }).passthrough()),
  quotes: z.array(z.object({
    address, suite_id: z.string(), symbol: z.string(), decimals: z.number().int(), registered: z.boolean(),
    selectable: z.boolean(), route: z.enum(['standard', 'rwa']), asset_type: z.string().nullable().optional(),
  }).passthrough()),
});

export class O1 {
  constructor(private readonly key: string | undefined = process.env.O1_API_KEY,
    private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(path: string, schema: z.ZodType<T>, body?: unknown, idempotencyKey?: string): Promise<T> {
    requireCondition(path.startsWith('/') && !path.startsWith('//'), 'Invalid o1 API path');
    const headers = new Headers({ accept: 'application/json' });
    if (path !== '/health') {
      requireCondition(this.key, 'Set a scoped O1_API_KEY on the operator machine');
      headers.set('x-api-key', this.key);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
    let response: Response;
    try {
      response = await this.fetcher(origin + path, {
        headers, method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new Error('o1 API request failed before a response');
    }
    requireCondition(response.ok, `o1 ${path.split('?')[0]} returned HTTP ${response.status}`);
    try {
      return schema.parse(await response.json());
    } catch {
      throw new Error(`Unexpected o1 response at ${path.split('?')[0]}`);
    }
  }

  async get<T>(path: string, schema: z.ZodType<T>) {
    return this.request(path, z.object({ data: schema, meta: z.object({ generated_at: timestamp }).passthrough(),
      summary: z.unknown().optional(), pagination: z.unknown().optional() }));
  }

  async post<T>(path: string, schema: z.ZodType<T>, body: unknown, key?: string) {
    const reply = await this.request(path, z.object({ data: schema }), body, key);
    return reply.data;
  }

  async config() {
    return (await this.get('/config?chain_id=8453&market=all&launch_product=non-tax&include=chains,suites,quotes&active_only=false', configuration)).data;
  }

  async health() {
    return this.request('/health', z.object({ status: z.literal('ok'), api_version: z.string(), build_id: z.string(), time: timestamp }));
  }
}
