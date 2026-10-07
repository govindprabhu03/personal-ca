// "Ask your CA" with a scripted fake model: no network, no API key. This proves OUR side (tools, privacy, loop safety),
// not the model's judgement: that needs a live key (see README).
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { LlmClient } from '../src/ask/agent';
import { runTool } from '../src/ask/tools';
import { openDb } from '../src/db';

type Step = (params: any) => { content: any[]; stop_reason: string };
let script: Step[] = [];
let calls: any[] = [];
const fake: LlmClient = { beta: { messages: { create: async (p: any) => {
  calls.push(structuredClone(p));
  const step = script.shift();
  if (!step) throw new Error('script exhausted');
  return step(p);
} } } };
const say = (text: string): Step => () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const use = (...tools: [string, unknown][]): Step => () => ({
  content: tools.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })), stop_reason: 'tool_use',
});

const db = openDb(':memory:');
let base = '', server: ReturnType<ReturnType<typeof createApp>['listen']>;
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const ask = (question: string, history: unknown[] = []) => post('/api/ask', { question, history });

beforeAll(async () => {
  server = createApp(db, { today: () => '2026-03-10', llm: fake }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await post('/api/income', { amount_paise: 3000000, received_at: '2026-03-01T09:00:00', is_regular: true });
  await post('/api/accounts', { kind: 'bank', name: 'HDFC Salary 1234', opening_paise: 0 });
  // a raw bank narration full of identifiers, and a manual spend with a private free-text note
  await post('/api/import', { commit: true, csv: 'Date,Narration,Withdrawal Amt.,Deposit Amt.\n02/03/26,UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI,"1,250.50",' });
  await post('/api/transactions', { amount_paise: 34000, merchant_raw: 'Zomato', note: "ria's birthday, call 9876543210", occurred_at: '2026-03-05T23:30:00' });
});
afterAll(() => { server.close(); });

describe('Ask your CA', () => {
  it('runs parallel tool calls, returns every result in ONE message, and never leaks identifiers to the model', async () => {
    calls = [];
    script = [
      use(['find_transactions', { query: 'swiggy', from: '2026-03-01', to: '2026-03-31' }], ['spend_summary', { month: '2026-03', group_by: 'merchant' }]),
      say('You spent ₹1,250.50 at Swiggy in March 🍔'),
    ];
    const r = await ask('How much did I spend on Swiggy in March?');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ answer: 'You spent ₹1,250.50 at Swiggy in March 🍔', tools_used: ['find_transactions', 'spend_summary'] });

    const everything = JSON.stringify(calls);
    for (const secret of ['swiggy@icici', 'ICIC0001', '4123', '9876543210', "ria's birthday", 'HDFC Salary']) expect(everything).not.toContain(secret);

    const results = calls[1].messages.at(-1);
    expect(results.role).toBe('user');
    expect(results.content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result']); // parallel calls answered together
    const found = JSON.parse(results.content[0].content), summary = JSON.parse(results.content[1].content);
    expect([found.matches, found.total_inr, found.transactions[0].merchant]).toEqual([1, 1250.5, 'Swiggy']);
    expect([summary.spent_inr, summary.groups.map((g: any) => g.key)]).toEqual([1590.5, ['Swiggy', 'Zomato']]);
    expect(Object.keys(found.transactions[0]).sort()).toEqual(['amount_inr', 'bucket', 'category', 'date', 'merchant']); // the whole privacy surface
  });

  it('sends the documented model setup: all tools, low effort, today in the prompt, refusal fallback on', async () => {
    const p = calls[0];
    expect([p.model, p.output_config, p.fallbacks, p.betas]).toEqual(['claude-opus-5-5', { effort: 'low' }, 'default', ['server-side-fallback-2026-07-01']]);
    expect(p.tools.map((t: any) => t.name)).toEqual(['spend_summary', 'list_flags', 'savings_status', 'safe_to_spend', 'find_transactions', 'monthly_report', 'subscriptions', 'bills', 'friends']);
    expect(p.system).toContain('Today is 2026-03-10');
    expect(p.system).toContain('Never add up');
  });

  it('turns bad tool input into an error result so the model can retry', async () => {
    calls = [];
    script = [use(['spend_summary', { month: '2026-13' }]), use(['spend_summary', { month: '2026-03' }]), say('Done')];
    const r = await ask('March spending?');
    expect(r.json.answer).toBe('Done');
    const first = calls[1].messages.at(-1).content[0];
    expect(first.is_error).toBe(true);
    expect(first.content).toContain('month');
    expect(JSON.parse(calls[2].messages.at(-1).content[0].content).spent_inr).toBe(1590.5);
  });

  it('reports an unknown tool as an error instead of crashing', async () => {
    calls = [];
    script = [use(['transfer_money', { amount: 1 }]), say('Sorry, I can only look things up.')];
    await ask('send money');
    expect(calls[1].messages.at(-1).content[0]).toMatchObject({ is_error: true });
  });

  it('handles refusals gracefully', async () => {
    script = [() => ({ content: [], stop_reason: 'refusal' })];
    expect((await ask('anything')).json.answer).toContain("can't help");
  });

  it('stops a runaway tool loop after 6 turns', async () => {
    calls = [];
    script = Array.from({ length: 20 }, () => use(['bills', {}]));
    const r = await ask('loop forever');
    expect(calls).toHaveLength(6);
    expect(r.json.answer).toContain('lost');
  });

  it('forwards recent chat history as plain text turns', async () => {
    calls = [];
    script = [say('Yes')];
    await ask('And last month?', [{ role: 'user', text: 'March?' }, { role: 'assistant', text: '₹1,590.50' }]);
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'March?' }, { role: 'assistant', content: '₹1,590.50' }, { role: 'user', content: 'And last month?' }]);
  });

  it('validates input, explains a missing key, and maps credential errors to a clear 503', async () => {
    expect((await ask('   ')).status).toBe(400);
    const off = createApp(openDb(':memory:'), { llm: null }).listen(0);
    await new Promise((r) => off.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'hi' }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('ANTHROPIC_API_KEY');
    off.close();
    script = [() => { throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.'); }];
    expect((await ask('hi')).status).toBe(503);
  });
});

describe('tool results are computed server-side', () => {
  it('find_transactions totals ALL matches, not just the rows shown', () => {
    const r = runTool(db, 'find_transactions', { from: '2026-03-01', to: '2026-03-31', limit: 1 }, '2026-03-10') as any;
    expect([r.matches, r.showing, r.total_inr, r.transactions]).toEqual([2, 1, 1590.5, expect.any(Array)]);
    expect(r.transactions).toHaveLength(1);
  });
  it('the other tools return rupee figures the model can quote verbatim', () => {
    const s = runTool(db, 'safe_to_spend', {}, '2026-03-10') as any;
    expect([s.income_inr, s.spent_so_far_inr, s.days_left]).toEqual([30000, 1590.5, 22]);
    expect((runTool(db, 'savings_status', {}, '2026-03-10') as any).savings_target_pct).toBe(20);
    expect((runTool(db, 'friends', {}, '2026-03-10') as any).owed_to_user_inr).toBe(0);
    expect((runTool(db, 'list_flags', { month: '2026-03', detector: 'late_night' }, '2026-03-10') as any).flags[0].detector).toBe('late_night');
  });
});
