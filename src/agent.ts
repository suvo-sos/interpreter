// Silent interpreter agent, called through OpenRouter.
// The agent never speaks out loud — it only returns text for the glasses.

export interface InterpretResult {
  /** What the other person just said, in plain English. Empty when the utterance was the user speaking. */
  theySaidEn: string
  /** Exactly what the user should say back, in the other person's language. Empty when the utterance was theirs. */
  sayThis: string
  /** A gesture tip that helps, e.g. "show 2 fingers". Empty when none helps. */
  gesture: string
  /** The other person's language code, e.g. "bn" for Bengali. */
  lang: string
}

const SYSTEM_PROMPT = `You are a silent interpreter on smart glasses. You sit in the middle of a live face-to-face conversation between the user (who speaks English) and another person (who usually speaks Bengali, but may speak another language).

Rules:
- You NEVER speak out loud. The user reads you only as text on their glasses.
- For each utterance, detect its language:
  - English = the USER speaking. Translate what they want to say into the other person's language and tell the user exactly what to say. Fill "sayThis" with the phrase in the other language. Leave "theySaidEn" empty.
  - Another language = the OTHER PERSON speaking. Translate it into plain English. Fill "theySaidEn". Leave "sayThis" empty.
- Keep both outputs to one short line each, plain words, no extra explanation.
- Add a "gesture" tip only when a hand gesture would help (for example "show 2 fingers" when a number matters). Otherwise leave it empty.
- Remember the other person's language from the conversation. If they speak a language other than Bengali, switch "lang" to that language's code and keep using it.
- Reply with JSON only, no markdown fences, no extra text:
{"theySaidEn": "...", "sayThis": "...", "gesture": "...", "lang": "bn"}`

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class InterpreterAgent {
  private history: ChatMessage[] = []
  private targetLang = 'bn'

  constructor(
    private apiKey: string,
    private model: string,
    // When set, the agent runs on the Hermes server instead of OpenRouter —
    // the server holds the key and the shared conversation memory.
    private baseUrl?: string,
  ) {}

  async interpret(text: string): Promise<InterpretResult> {
    if (this.baseUrl) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Hermes server ${res.status}: ${body.slice(0, 200)}`)
      }
      const result = (await res.json()) as InterpretResult
      return {
        theySaidEn: (result.theySaidEn ?? '').toString().trim(),
        sayThis: (result.sayThis ?? '').toString().trim(),
        gesture: (result.gesture ?? '').toString().trim(),
        lang: (result.lang ?? this.targetLang).toString().trim() || this.targetLang,
      }
    }
    if (!this.apiKey) throw new Error('OpenRouter key not set — add it to .env.local')
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.history.slice(-20),
      { role: 'user', content: text },
    ]
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/suvo-sos/interpreter',
        'X-Title': 'Interpreter',
      },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json()
    const raw: string = data.choices?.[0]?.message?.content ?? ''
    const parsed = parseJson(raw)
    const result: InterpretResult = {
      theySaidEn: (parsed.theySaidEn ?? '').toString().trim(),
      sayThis: (parsed.sayThis ?? '').toString().trim(),
      gesture: (parsed.gesture ?? '').toString().trim(),
      lang: (parsed.lang ?? this.targetLang).toString().trim() || this.targetLang,
    }
    this.targetLang = result.lang
    this.history.push({ role: 'user', content: text })
    this.history.push({ role: 'assistant', content: JSON.stringify(result) })
    return result
  }
}

function parseJson(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    return {}
  }
}
