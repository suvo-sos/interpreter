import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { InterpreterAgent, type InterpretResult } from './agent'
import { mountUi, setStatus, addTurn, onDebugSend, onPreview } from './ui'

mountUi()

const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY as string
const AGENT_MODEL = (import.meta.env.VITE_AGENT_MODEL as string) || 'recursive/flint-v1.0:free'
// When set, the glasses talk to the Hermes server instead of OpenRouter —
// the server holds the key and the shared conversation memory, and the
// Telegram bot is the other end of the same conversation.
const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string) || ''

if (!API_KEY && !AGENT_URL) {
  setStatus('error', 'Key not set — add it to .env.local')
  console.warn('VITE_OPENROUTER_API_KEY is not set.')
} else if (!API_KEY && AGENT_URL) {
  setStatus('paused', 'Server mode · mic needs a key')
}

const agent = (API_KEY || AGENT_URL) ? new InterpreterAgent(API_KEY, AGENT_MODEL, AGENT_URL || undefined) : null

// The bridge only exists inside the Even Hub WebView / simulator. In a plain
// browser (dev on a laptop) it never resolves — time out and run in
// companion-only mode so the debug input still works.
type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>
async function waitForBridge(timeoutMs: number): Promise<Bridge | null> {
  try {
    return await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>(resolve => window.setTimeout(() => resolve(null), timeoutMs)),
    ])
  } catch {
    return null
  }
}

const bridge = await waitForBridge(3000)
let glassesOn = bridge !== null

let lastThey = ''
let lastSay = ''
let lastGesture = ''
let micPaused = false
let lastTheyRender = ''
let lastSayRender = ''
let renderTimer: number | null = null

function theyContent(): string {
  if (micPaused) return 'Paused'
  if (!micOn && !lastThey) return 'Tap to start'
  return lastThey ? `THEY: ${lastThey}`.slice(0, 120) : 'Listening…'
}

function sayContent(): string {
  if (!lastSay) return 'SAY: …'
  return `SAY: ${lastSay}${lastGesture ? `\n${lastGesture}` : ''}`.slice(0, 120)
}

if (bridge) {
  // Two containers: THEY (small, top) and SAY (the hero line, boxed).
  const they = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 90,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'they',
    content: 'Tap to start',
    isEventCapture: 0,
  })
  const say = new TextContainerProperty({
    xPosition: 0,
    yPosition: 100,
    width: 576,
    height: 188,
    borderWidth: 2,
    borderColor: 5,
    borderRadius: 8,
    paddingLength: 8,
    containerID: 2,
    containerName: 'say',
    content: 'SAY: …',
    isEventCapture: 1,
  })

  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [they, say] }),
  )
  if (created !== 0) {
    // No real host behind the bridge (plain browser) — the glasses container
    // can't be created. Fall back to companion-only mode; the debug input
    // and conversation log still work. Not an error.
    glassesOn = false
    console.warn(`createStartUpPageContainer failed: ${created} — companion-only mode`)
  }
}

function scheduleGlassesRender() {
  if (!glassesOn || !bridge) return
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    const they = theyContent()
    if (they !== lastTheyRender) {
      lastTheyRender = they
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 1, containerName: 'they', content: they }),
      )
    }
    const say = sayContent()
    if (say !== lastSayRender) {
      lastSayRender = say
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 2, containerName: 'say', content: say }),
      )
    }
  }, 120) // debounce display writes — BLE render queue is slow
}

let processing = false
let pendingText: string | null = null

async function handleUtterance(text: string) {
  const clean = text.trim()
  if (!clean) return
  if (!agent) {
    setStatus('error', 'Key not set — add it to .env.local')
    return
  }
  if (processing) {
    pendingText = clean
    return
  }
  processing = true
  try {
    setStatus('listening', 'Thinking…')
    const result = await agent.interpret(clean)
    if (result.theySaidEn) lastThey = result.theySaidEn
    if (result.sayThis) {
      lastSay = result.sayThis
      lastGesture = result.gesture
    }
    addTurn(result)
    scheduleGlassesRender()
    setStatus('listening', 'Microphone live · tap to pause · double-tap to exit')
  } catch (err) {
    setStatus('error', `Agent error: ${(err as Error)?.message ?? err}`)
    console.error('Agent error:', err)
  } finally {
    processing = false
    if (pendingText) {
      const next = pendingText
      pendingText = null
      void handleUtterance(next)
    }
  }
}

// Preview layout: renders a sample turn through the same glasses path,
// without calling the agent — so the look can be judged before the key is set.
onPreview(() => {
  const sample = { theySaidEn: 'who are you?', sayThis: 'ami jol khabo', gesture: 'show 2 fingers', lang: 'bn' }
  lastThey = sample.theySaidEn
  lastSay = sample.sayThis
  lastGesture = sample.gesture
  addTurn(sample)
  scheduleGlassesRender()
})

// Debug input (companion UI) runs the same path as a transcribed utterance,
// so the agent loop can be tested without a mic.
onDebugSend(text => void handleUtterance(text))

// The default stt.ts is a blank stub that throws. Catch the throw so the UI
// surfaces the "configure stt.ts" error chip instead of hanging on "Connecting…".
let stt: ReturnType<typeof startSttStream> | null = null
if (glassesOn && API_KEY) {
  try {
    stt = startSttStream(
      API_KEY,
      ({ finalText }) => {
        if (finalText.trim()) void handleUtterance(finalText)
      },
      err => {
        setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
        console.error('STT error:', err)
      },
    )
  } catch (err) {
    setStatus('error', (err as Error)?.message ?? 'STT startup failed')
    console.error('STT startup failed:', err)
  }
}

let micOn = false
if (glassesOn && bridge) {
  // Mic starts OFF — the first temple tap activates the agent.
  // No key: the KEY NOT SET chip from the top stays — the tap still works,
  // the agent just can't process anything until the key is added.
  if (API_KEY) setStatus('paused', 'Tap the temple to start listening · double-tap to exit')
} else if (!glassesOn && API_KEY) {
  setStatus('listening', 'Companion mode — type below to test the agent')
}

// Tap toggles capture. `audioControl(false)` stops the host pushing PCM, so no
// further frames reach `sendPcm`; the STT client itself is left open.
// Deliberately does NOT require the STT object: without a key there is no STT
// yet, but the tap must still work — the glasses show Listening… and the
// KEY NOT SET chip stays until the key is added.
function toggleMic() {
  if (!bridge) return
  micOn = !micOn
  bridge.audioControl(micOn)
  micPaused = !micOn
  scheduleGlassesRender()
  if (API_KEY) {
    setStatus(
      micOn ? 'listening' : 'paused',
      micOn ? 'Microphone live · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
    )
  }
}

let cleanedUp = false
let unsubscribe: (() => void) | null = null
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge?.audioControl(false)
  stt?.close()
  unsubscribe?.()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all — and in this template
// that means every incoming audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing, critical details:
//   • Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Audio PCM frames come through `event.audioEvent` — separate branch.
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
if (bridge) {
  unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm) stt?.sendPcm(pcm)

    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1)
      return
    }

    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      toggleMic()
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      cleanup()
    }
  })
}

window.addEventListener('beforeunload', cleanup)

// Connector: poll the Hermes server's shared turns feed, so a Telegram
// message lands on the glasses. Only 'telegram' turns are rendered — the
// glasses' own turns are already shown from the interpret response.
let lastTurnId = 0
let pollingTurns = false
if (AGENT_URL) {
  window.setInterval(async () => {
    if (pollingTurns) return
    pollingTurns = true
    try {
      const res = await fetch(`${AGENT_URL.replace(/\/$/, '')}/turns?since=${lastTurnId}`)
      if (!res.ok) return
      const data = (await res.json()) as { turns?: Array<InterpretResult & { id: number; source: string }> }
      for (const t of data.turns ?? []) {
        lastTurnId = Math.max(lastTurnId, t.id)
        if (t.source !== 'telegram') continue
        if (t.theySaidEn) lastThey = t.theySaidEn
        if (t.sayThis) {
          lastSay = t.sayThis
          lastGesture = t.gesture ?? ''
        }
        addTurn(t)
        scheduleGlassesRender()
      }
    } catch {
      // Server unreachable — the glasses keep working in direct mode.
    } finally {
      pollingTurns = false
    }
  }, 3000)
}
