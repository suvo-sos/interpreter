import type { InterpretResult } from './agent'

type Status = 'connecting' | 'listening' | 'paused' | 'error'

let statusEl: HTMLDivElement
let logEl: HTMLDivElement
let inputEl: HTMLInputElement

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Interpreter</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>
      <section id="log" class="log" aria-live="polite"></section>
      <section class="debug">
        <div class="debug-row">
          <input id="debug-input" type="text" placeholder="Type what was said… (test without mic)" autocomplete="off" />
          <button id="debug-send">Send</button>
        </div>
        <div class="chips">
          <button data-say="tumi ke?">tumi ke?</button>
          <button data-say="jol to amar nai">jol to amar nai</button>
          <button data-say="I want water">I want water</button>
          <button id="preview-btn">Preview layout</button>
        </div>
      </section>
      <footer>Tap the temple to start / pause · double-tap to exit.</footer>
    </main>
  `
  statusEl = app.querySelector<HTMLDivElement>('#status')!
  logEl = app.querySelector<HTMLDivElement>('#log')!
  inputEl = app.querySelector<HTMLInputElement>('#debug-input')!
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function addTurn(result: InterpretResult) {
  if (!logEl) return
  const row = document.createElement('div')
  row.className = 'turn'
  if (result.theySaidEn) {
    const they = document.createElement('div')
    they.className = 'they'
    they.textContent = `They: ${result.theySaidEn}`
    row.appendChild(they)
  }
  if (result.sayThis) {
    const say = document.createElement('div')
    say.className = 'say'
    say.textContent = `Say: ${result.sayThis}${result.gesture ? ` (${result.gesture})` : ''}`
    row.appendChild(say)
  }
  if (!row.hasChildNodes()) return
  logEl.appendChild(row)
  logEl.scrollTop = logEl.scrollHeight
}

/** Wires the Preview layout button. Renders a sample turn without calling the agent. */
export function onPreview(cb: () => void) {
  document.querySelector<HTMLButtonElement>('#preview-btn')!.addEventListener('click', cb)
}

/** Wires the debug input + canned chips. Fires for typed or canned utterances. */
export function onDebugSend(cb: (text: string) => void) {
  const sendBtn = document.querySelector<HTMLButtonElement>('#debug-send')!
  const send = () => {
    const text = inputEl.value.trim()
    if (!text) return
    inputEl.value = ''
    cb(text)
  }
  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') send()
  })
  document.querySelectorAll<HTMLButtonElement>('.chips button').forEach(btn => {
    btn.addEventListener('click', () => cb(btn.dataset.say ?? ''))
  })
}

function injectStyles() {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening  { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-paused     { color: #E5E5E5; border-color: #7B7B7B; background: rgba(229,229,229,0.06); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .log { flex: 1; overflow: auto; background: #2E2E2E; border: 1px solid #3E3E3E;
      border-radius: 12px; padding: 20px; min-height: 180px; }
    .turn { padding: 10px 0; border-bottom: 1px solid #3E3E3E; line-height: 1.5; }
    .turn:last-child { border-bottom: none; }
    .they { color: #E5E5E5; }
    .say { color: #3CFA44; margin-top: 4px; }
    .debug { display: flex; flex-direction: column; gap: 8px; }
    .debug-row { display: flex; gap: 8px; }
    .debug-row input { flex: 1; background: #2E2E2E; border: 1px solid #3E3E3E;
      color: #E5E5E5; border-radius: 8px; padding: 10px 12px; font-size: 15px; outline: none; }
    .debug-row input:focus { border-color: #3CFA44; }
    .debug-row button, .chips button { background: #3E3E3E; color: #E5E5E5;
      border: 1px solid #3E3E3E; border-radius: 8px; padding: 10px 14px;
      font-size: 14px; cursor: pointer; }
    .debug-row button:hover, .chips button:hover { border-color: #3CFA44; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
