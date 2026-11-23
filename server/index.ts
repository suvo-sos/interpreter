// The Interpreter's home on Telegram.
//
// One small server that does two things, both through the SAME agent
// (src/agent.ts) the glasses app uses:
//   1. A Telegram bot — DM it any utterance and it replies with the
//      interpretation ("They said: ..." / "Say this: ...").
//   2. POST /interpret — an HTTP endpoint for the glasses app, so a turn on
//      the glasses is mirrored into a Telegram chat (the conversation lives
//      in Telegram) and shares the agent's memory with the bot.
//
// No new dependencies: plain Node http + fetch. Run it with `npm run server`
// from the repo root. It reads the same .env.local the web app uses.
//
// Env:
//   OPENROUTER_API_KEY (or VITE_OPENROUTER_API_KEY) — the agent key.
//   AGENT_MODEL (or VITE_AGENT_MODEL) — default recursive/flint-v1.0:free.
//   TELEGRAM_BOT_TOKEN — from @BotFather. Without it the bot stays off
//     and the server still serves /interpret.
//   TELEGRAM_CHAT_ID — your Telegram chat id; glasses turns are mirrored
//     there. Without it, no mirroring.
//   PORT — default 3001.

import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { InterpreterAgent, type InterpretResult } from '../src/agent'

// Load .env.local (same file the web app uses) so the server shares the key.
for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
}

const PORT = Number(process.env.PORT || 3001)
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || ''
const MODEL = process.env.AGENT_MODEL || process.env.VITE_AGENT_MODEL || 'recursive/flint-v1.0:free'
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

const agent = API_KEY ? new InterpreterAgent(API_KEY, MODEL) : null

// Shared turns feed — the connector between the glasses and the Telegram bot.
// Every interpreted turn (from a bot DM or from POST /interpret) is appended
// here, so the glasses can poll GET /turns and show Telegram messages.
interface Turn extends InterpretResult {
  id: number
  source: 'glasses' | 'telegram'
  at: number
}
const turns: Turn[] = []
let nextTurnId = 1
function addTurn(result: InterpretResult, source: Turn['source']): Turn {
  const turn: Turn = { ...result, id: nextTurnId++, source, at: Date.now() }
  turns.push(turn)
  while (turns.length > 50) turns.shift()
  return turn
}

function formatTurn(r: InterpretResult): string {
  const lines: string[] = []
  if (r.theySaidEn) lines.push(`They said: ${r.theySaidEn}`)
  if (r.sayThis) lines.push(`Say this: ${r.sayThis}`)
  if (r.gesture) lines.push(`(${r.gesture})`)
  return lines.join('\n') || 'I could not understand that.'
}

async function tg(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok: boolean; result?: unknown; description?: string }
}

// Long-poll getUpdates. One loop, no webhooks, no extra server needed.
async function pollBot() {
  let offset = 0
  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 30 })
      const updates = (data.result as Array<{ update_id: number; message?: { text?: string; chat: { id: number } } }> | undefined) ?? []
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        const msg = u.message
        if (!msg?.text) continue
        const chatId = msg.chat.id
        const text = msg.text.trim()
        if (text === '/start') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Interpreter — send me what someone said, and I will tell you what it means and what to say back.\nTry: tumi ke?',
          })
          continue
        }
        if (!agent) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'The agent key is not set yet. Add it to .env.local and restart the server.',
          })
          continue
        }
        try {
          const result = await agent.interpret(text)
          addTurn(result, 'telegram')
          await tg('sendMessage', { chat_id: chatId, text: formatTurn(result) })
        } catch (err) {
          await tg('sendMessage', { chat_id: chatId, text: `Agent error: ${(err as Error)?.message ?? err}` })
        }
      }
    } catch (err) {
      console.error('Telegram poll error:', (err as Error)?.message ?? err)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, bot: Boolean(TG_TOKEN), key: Boolean(API_KEY) }))
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/turns')) {
    const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since') || 0)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ turns: turns.filter(t => t.id > since) }))
    return
  }

  if (req.method === 'POST' && req.url === '/interpret') {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(raw || '{}') as { text?: string }
        if (!text?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'text is required' }))
          return
        }
        if (!agent) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'OpenRouter key not set — add it to .env.local' }))
          return
        }
        const result = await agent.interpret(text)
        addTurn(result, 'glasses')
        // Mirror the turn into Telegram so the conversation lives there too.
        if (TG_CHAT_ID) {
          tg('sendMessage', { chat_id: TG_CHAT_ID, text: `Glasses:\n${formatTurn(result)}` }).catch(() => {})
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'interpret failed' }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`Hermes server on http://localhost:${PORT} — key: ${API_KEY ? 'set' : 'MISSING'}, bot: ${TG_TOKEN ? 'on' : 'off (set TELEGRAM_BOT_TOKEN)'}`)
  if (TG_TOKEN) void pollBot()
})
