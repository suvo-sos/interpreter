# Interpreter — a silent interpreter on Even Realities G2

A live interpreter that sits in the middle of a face-to-face conversation. It hears both people, tells you what the other person said, and tells you exactly what to say back — silently, as text on your glasses. The other person never hears the agent.

Built for the **Even Realities G2 'Heads Up' hackathon** (DoraHacks, Nov 23–29, 2026), **Track 4: AI Assistants & Work**.

## How it works

```
Glasses mic → speech-to-text → interpreter agent (OpenRouter) → 2 lines on the glasses
```

- The other person says something in their language → glasses show **THEY: ...** in English.
- You want to say something in English → glasses show **SAY: ...** in their language, plus a gesture tip when one helps (e.g. "show 2 fingers").
- The agent is silent. G2 has no speaker anyway — text only, by design.

Example: a Bengali guy says "tumi ke?" → you see **"who are you?"**. You want water → the agent says **"say: ami jol khabo"**. He says "jol to amar nai" → you see **"he says he doesn't have water"**.

## What kind of app is this?

A **web app built only for G2**. HTML + TypeScript + Vite, running inside the Even Realities app on your phone, talking to the glasses over Bluetooth through the Even Hub SDK. It is not a normal website and not a native phone app — the glasses are its screen. No glasses? The free simulator on your Mac pretends to be the glasses.

## Setup

```bash
npm install
cp .env.example .env.local
```

Then paste your OpenRouter API key into `.env.local`.

One key covers both listening (audio model) and interpreting (agent model). Default agent model is the free `recursive/flint-v1.0:free` — switch `VITE_AGENT_MODEL` to a Claude model for better Bengali.

## Run

Run these in two terminals. The first serves the app on http://localhost:5173, the second opens the simulator with the 576×288 green canvas.

```bash
npm run dev
```

```bash
npm run simulate
```

Or on real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan the QR in the Even app.

## Test it (no mic needed)

Open http://localhost:5173 in a browser. Type in the test box, or tap a canned line:

- `tumi ke?` → the agent translates what he said
- `jol to amar nai` → "he says he doesn't have water"
- `I want water` → the agent tells you what to say back

The same two lines appear in the conversation log and on the simulator canvas.

## Telegram bot (the agent's home)

The same agent also lives in Telegram. DM it any utterance and it replies with the interpretation — same prompt, same memory as the glasses.

1. In Telegram, message @BotFather, send `/newbot`, pick a name. It gives you a token.
2. Put the token in `.env.local` as `TELEGRAM_BOT_TOKEN`, and your chat id as `TELEGRAM_CHAT_ID` (message @userinfobot to find it).
3. Run the server in a third terminal:

```bash
npm run server
```

Then DM your bot: `tumi ke?` → it replies "They said: who are you?".

The server also exposes `POST /interpret` (same JSON the agent returns) — the glasses app will use it so a turn on the glasses is mirrored into your Telegram chat and shares the agent's memory with the bot.

## Stack

- Even Hub SDK + ASR template (mic → PCM s16le 16 kHz mono)
- OpenRouter: `openai/gpt-audio-mini` for transcription, agent model for interpretation
- Vite + TypeScript
