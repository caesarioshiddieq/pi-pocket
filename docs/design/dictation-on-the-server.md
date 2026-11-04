# Dictation on the server (design)

Status: built on the `dictation-server` branch, unreleased. Facts were checked in this checkout (Pi Pocket 0.27.0, Node 26.12.1) on 2026-11-04. The tests named here exist and pass. Numbers from Groq's documentation are marked as such; the latency was measured.

## Intent, and why

Dictation today uses the browser's Web Speech API (`web/voice.js`). It needs Google's speech keys inside the browser build. The owner's laptop runs Brave 1.98.63, a Chromium build without those keys, so every attempt ends in `ERROR network` after `AUDIO` and no words arrive. The owner wants dictation that works in Brave, at no cost, and has no OpenAI credit.

## Goals

- Dictate in Brave, and in any browser without Web Speech keys.
- Cost nothing: the free tier of a hosted service, and no credit card.
- Keep dictation where it is: the message box, PiP's box, Alt+V, no auto-send, words kept as a draft.
- Keep the key on the server. Nothing in the browser sees it.

## Non-goals

- Live words while speaking. The server path inserts text once, when the clip ends.
- A local model on this VM (see Approaches).
- Word-level caret surgery. The server path inserts one finished phrase at the caret.

## Anti-goals

- Audio stored anywhere. The clip lives in memory for one request.
- A paid fallback the owner did not agree to. When the free quota is spent, dictation says so and stops.

## Constraints

- VM: 2 vCPU, 3.9 GB RAM, no swap, 2.6 GB free disk (94% used).
- No `ffmpeg`, no `g++`, no `cmake`, and no `pip` or `ensurepip`.
- `openai:api_key` exists but has no credit. Not usable.
- No Cloudflare or Groq account exists yet; the owner must create one and give a key.
- Server files run through Node type stripping: no enums, no parameter properties.
- `web/**` edits reload every open tab at once. A syntax error blanks the app for everyone.
- The owner presses Menu → Restart server for `src/server/**` changes.

## Approaches

1. **Use Google Chrome or Safari for dictation.** Free, no code, best quality. Rejected by the owner: it means leaving Brave.
2. **Local model on this VM.** whisper.cpp cannot be built (no C++, no cmake). A WASM build through npm would need a model download on a disk with 2.6 GB free, take the CPU from Pi Pocket on 2 vCPU, and transcribe Indonesian poorly at the sizes that fit. Rejected.
3. **Groq's free tier.** Chosen. It speaks the OpenAI audio API: multipart upload to `https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo`. The key takes a minute to create and needs no card. Free limits on this model are 20 requests per minute, 2,000 per day, 7,200 audio-seconds per hour and 28,800 per day (about 8 hours of speech per day), 25 MB per file. Transcription is very fast and strong in Indonesian.

Cloudflare Workers AI was the other free candidate. Its whisper call wants base64 audio inside JSON and a second credential (account id plus token), so it is more code for a smaller free allowance.

## Decisions the owner made

- No paid service.
- Groq's free tier, not a local model, not another browser.

## How it works

**Server.** `src/server/voice.ts` holds one function: take a clip's bytes and its content type, send them to Groq, return the text. `src/server/http/api.ts` gains `POST /api/voice/transcribe`, which needs a signed-in person and the `X-Pocket` header like every other POST. It reads the body with `readBody(request, 20 MB)` and rejects a clip over 120 seconds or 20 MB. The key is read per request from `~/.pi-pocket/groq-api-key`, which the owner writes with mode 600; it is never logged and never leaves the server. A missing key, a rejected key, or a spent quota comes back as a notice that says which one it was.

**Client.** `web/voice.js` gains a second engine:

- Server mode records with `getUserMedia` and `MediaRecorder` (`audio/webm;codecs=opus`, `audio/mp4` where that is refused), sends one Blob through `api("voice/transcribe", blob)`, and inserts the answer with the existing `join()`, so spacing and capitalisation match the browser path.
- Hold to talk: pointer down starts, pointer up, pointer cancel, or the pointer leaving the button stops and sends. A press shorter than 400 ms is discarded with a hint, so a stray tap sends no clip. Alt+V still starts and stops.
- The mic shows wherever recording works, so Firefox gets a mic too.
- Mode: server dictation is used when there is no recognizer, when the browser's recognizer failed with `network` once (remembered in `localStorage`), or when the person turns it on. Otherwise the browser recognizer stays the default: it shows words as they are spoken and costs nothing.
- Notices: the existing `network` message gains an action to retry with server dictation.

**Docs.** The Dictation bullet in `docs/features.md` is rewritten to say both engines exist, where the audio goes, and that it needs the owner's Groq key.

## Calls made while building

- Model `whisper-large-v3-turbo`, with one fallback to `whisper-large-v3` if that model is refused.
- No `language` field: Groq detects it, so Indonesian works without a setting.
- Any signed-in person may transcribe, using the owner's key, capped by the size and length limits above. A setting to restrict it to the owner can come later.
- Reply is JSON `{ text }`.
- `localStorage` key `pocket.dictation` holds `"server"` or `"browser"`.
- Key file path `~/.pi-pocket/groq-api-key`, honouring `PI_POCKET_DIR` the way the rest of the app does.

## Testing

- `node --check web/voice.js`, `npm run check`, `npm run lint`, `npm test`.
- Server round trip without a browser: fetch `samples/jfk.wav` from the whisper.cpp repo (11 s of speech, 352 KB), post it through the new route's function, assert the returned text mentions the expected words.
- A missing key, a bad key, and an oversized clip each return their own notice.
- Check the app on a throwaway copy (`node test/serve.ts`) before the live server restarts.
- After the restart, the owner tests hold-to-talk in Brave on the laptop and on the phone.

## Risks

- A core change: a future Pi Pocket update can overwrite it.
- Each clip leaves the machine for Groq. The notice says so once.
- Free quota is shared with any other Groq use on this key, and a spent quota stops dictation until the next window.
- Two engines mean two failure modes; the notices must name which one failed.

## What the build added

The build followed this design, with three additions:

- A new `test/dictation-server.test.ts` stands in for Groq's answer, so the request shape, the model fallback, a refused key, a spent quota, and the refusals made before any request are covered without a network.
- The press releases the pointer this page took, inside a `try`: a pointer the page cannot capture still starts the dictation instead of throwing.
- The claim that `web/**` reloads every open tab means a half-written client is visible to people at once. `node --check web/voice.js` ran after each edit for that reason.

Measured on this VM: an 11-second clip of speech took 0.71 s at the route, and 0.5 s when the function was called directly. The free tier's billed minimum is 10 seconds per request, so a short clip costs the same as a 10-second one against the daily allowance.
