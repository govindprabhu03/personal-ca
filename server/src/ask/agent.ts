// "Ask your CA": a small tool-calling loop around the Claude API.
// Claude decides WHICH tool to call; our code runs it against the database and hands back the numbers.
// The model explains, it never calculates. The API key stays on this server, never in the app.
import type { DB } from '../db';
import { runTool, TOOL_DEFS } from './tools';

/** The slice of the SDK we use. Typed loosely so tests can inject a scripted fake instead of calling the network. */
export interface LlmMessage { content: any[]; stop_reason: string | null }
export interface LlmClient { beta: { messages: { create(params: Record<string, unknown>): Promise<LlmMessage> } } }
export interface ChatTurn { role: 'user' | 'assistant'; text: string }

const MAX_TURNS = 6; // tool round-trips per question; a runaway loop costs real money
// Server-side refusal fallback is only valid on these models (see the Claude API docs); CA_FALLBACK=off disables it.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export const systemPrompt = (today: string) => `You are "Ask your CA", the friendly money assistant inside a personal-finance app for a young person in India. The app judges spends as Need / Want / Waste and helps them save.

How you work:
- Today is ${today}. Resolve "this month", "last month", "September", "this week" into YYYY-MM or YYYY-MM-DD yourself before calling a tool.
- Answer ONLY from tool results. Every figure you state (amounts, totals, percentages, counts, dates) must be copied from a tool result. Never add up, average or estimate numbers yourself: if you need one, call a tool that returns it, or say you can't tell. Simple comparisons like "higher than last month" are fine.
- Amounts in tool results are in rupees (fields ending _inr). Write them as ₹1,250 or ₹1,250.50.
- Call several tools in one go when a question needs them. If a tool returns nothing, say there's no data for that period instead of guessing.
- You only see merchant names, amounts, dates and categories. Never ask the user for bank details, UPI IDs or account numbers.
- You explain how much to save and which habits to change. You do not recommend specific funds, stocks or investment products (that is regulated advice); if asked, say you can't, and point to the savings target instead.
- Tone: warm, upbeat, concise, never shaming. 2-5 short sentences or a short list. Plain text only (no markdown headings, tables or bold); a light emoji is fine.`;

const textOf = (content: any[]) => content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();

export async function askCa(
  db: DB, question: string, history: ChatTurn[],
  o: { client: LlmClient; today: string; model?: string; effort?: string },
): Promise<{ answer: string; tools_used: string[] }> {
  const model = o.model ?? process.env.CA_MODEL ?? 'claude-opus-5-5';
  const effort = o.effort ?? process.env.CA_EFFORT ?? 'low'; // Q&A over a small dataset: low effort keeps it quick and cheap
  const fallback = FALLBACK_MODELS.has(model) && process.env.CA_FALLBACK !== 'off';
  const messages: any[] = [...history.slice(-10).map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: question }];
  const used: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await o.client.beta.messages.create({
      model, max_tokens: 8000, system: systemPrompt(o.today), tools: TOOL_DEFS, messages, output_config: { effort },
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    });
    messages.push({ role: 'assistant', content: res.content }); // echo the whole turn back unchanged (thinking blocks must survive)

    if (res.stop_reason === 'refusal') return { answer: "I can't help with that one. Try asking about your spending, savings, bills or friends 💜", tools_used: used };
    if (res.stop_reason !== 'tool_use') {
      const answer = textOf(res.content);
      return { answer: answer || (res.stop_reason === 'max_tokens' ? 'That got long and I ran out of room. Could you ask a smaller question?' : "I couldn't come up with an answer. Could you rephrase?"), tools_used: used };
    }

    // Run every requested tool and return ALL results together in one user message.
    const results = res.content.filter((b) => b?.type === 'tool_use').map((b) => {
      if (!used.includes(b.name)) used.push(b.name);
      try { return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(runTool(db, b.name, b.input, o.today)) }; }
      catch (e: any) { return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: String(e?.issues ? e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e?.message ?? e)) }; }
    });
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'I got a bit lost digging through that. Could you ask it a simpler way?', tools_used: used };
}
