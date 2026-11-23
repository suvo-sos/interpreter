import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { InterpreterAgent } from './agent'
import { mountUi, setStatus, addTurn, onDebugSend } from './ui'

mountUi()

const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY as string
const AGENT_MODEL = (import.meta.env.VITE_AGENT_MODEL as string) || 'recursive/flint-v1.0:free'

if (!API_KEY) {
  setStatus('error', 'VITE_OPENROUTER_API_KEY not set — copy .env.example to .env.local')
  console.warn('VITE_OPENROUTER_API_KEY is not set.')
}

const agent = API_KEY ? new InterpreterAgent(API_KEY, AGENT_MODEL) : null

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
let lastRender = ''
let renderTimer: number | null = null

function glassesContent(): string {
  const lines: string[] = []
  if (lastThey) lines.push(`THEY: ${lastThey}`)
  if (lastSay) lines.push(`SAY: ${lastSay}${lastGesture ? ` (${lastGesture})` : ''}`)
  return lines.length ? lines.join('\n').slice(0, 240) : 'Listening…'
}

if (bridge) {
  const transcript = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'interpreter',
    content: 'Listening…',
    isEventCapture: 1,
  })

  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [transcript] }),
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
    const content = glassesContent()
    if (content === lastRender) return
    lastRender = content
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'interpreter',
        content,
      }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

let processing = false
let pendingText: string | null = null

async function handleUtterance(text: string) {
  const clean = text.trim()
  if (!clean) return
  if (!agent) {
    setStatus('error', 'VITE_OPENROUTER_API_KEY not set — copy .env.example to .env.local')
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
if (stt && glassesOn && bridge) {
  await bridge.audioControl(true)
  micOn = true
  setStatus('listening', 'Microphone live · tap to pause · double-tap to exit')
} else if (!glassesOn) {
  setStatus('listening', 'Companion mode — type below to test the agent')
}

// Tap toggles capture. `audioControl(false)` stops the host pushing PCM, so no
// further frames reach `sendPcm`; the STT client itself is left open.
function toggleMic() {
  if (!stt || !bridge) return
  micOn = !micOn
  bridge.audioControl(micOn)
  if (!micOn) {
    lastThey = ''
    lastSay = ''
    lastGesture = ''
    scheduleGlassesRender()
  }
  setStatus(
    micOn ? 'listening' : 'paused',
    micOn ? 'Microphone live · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
  )
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
