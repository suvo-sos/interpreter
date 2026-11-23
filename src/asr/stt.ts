// Speech-to-text for the G2 microphone.
//
// Mic PCM (s16le @ 16 kHz, mono) is buffered and split into utterances by a
// simple energy-based voice-activity check. Each finished utterance is sent
// to OpenRouter's audio model for transcription; the transcript comes back
// through onSnapshot, exactly like the template's streaming STT.

import { pcmToWav, blobToBase64 } from './wav'

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

// Energy VAD tuning: mic chunks are ~10-20ms; RMS above the threshold counts as speech.
const SPEECH_RMS = 500 // s16le RMS; quiet room noise sits well below this
const SILENCE_TO_END_MS = 700
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 15000

const STT_MODEL = 'openai/gpt-audio-mini'

async function transcribeAudio(apiKey: string, wav: Blob): Promise<string> {
  const base64 = await blobToBase64(wav)
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/suvo-sos/interpreter',
      'X-Title': 'Interpreter',
    },
    body: JSON.stringify({
      model: STT_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this audio exactly. Return only the transcription, no extra words.' },
            { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
          ],
        },
      ],
      temperature: 0,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`STT ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content ?? '').toString().trim()
}

function concatBytes(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of list) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export function startSttStream(
  apiKey: string,
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
): SttClient {
  let chunks: Uint8Array[] = []
  let speechMs = 0
  let silenceMs = 0
  let speaking = false
  let closed = false
  let busy = false

  function rms(chunk: Uint8Array): number {
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    return Math.sqrt(sum / Math.max(1, samples.length))
  }

  function chunkMs(chunk: Uint8Array): number {
    return (chunk.byteLength / 2 / 16000) * 1000
  }

  async function flushUtterance() {
    if (busy || chunks.length === 0) return
    const pcm = concatBytes(chunks)
    chunks = []
    speechMs = 0
    silenceMs = 0
    speaking = false
    if (closed) return
    busy = true
    try {
      const wav = pcmToWav(pcm)
      const text = await transcribeAudio(apiKey, wav)
      if (text && !closed) onSnapshot({ finalText: text, interimText: '', finished: true })
    } catch (err) {
      onError?.(err)
    } finally {
      busy = false
    }
  }

  return {
    sendPcm(chunk: Uint8Array) {
      if (closed) return
      const ms = chunkMs(chunk)
      const isSpeech = rms(chunk) > SPEECH_RMS
      if (isSpeech) {
        speaking = true
        speechMs += ms
        silenceMs = 0
        chunks.push(chunk)
      } else if (speaking) {
        silenceMs += ms
        chunks.push(chunk)
        if (silenceMs >= SILENCE_TO_END_MS || speechMs >= MAX_UTTERANCE_MS) {
          if (speechMs >= MIN_UTTERANCE_MS) void flushUtterance()
          else {
            chunks = []
            speechMs = 0
            silenceMs = 0
            speaking = false
          }
        }
      }
      // Silence before any speech is dropped.
    },
    close() {
      closed = true
      void flushUtterance()
    },
  }
}
