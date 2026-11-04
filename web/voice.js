// Dictation into a message box, with two engines. Where the browser has a recogniser of its own (Chrome, Safari) its
// words show in the box as they are heard, and stay once it settles on them. Where it has none, or cannot reach its own
// servers (Chromium builds without Google's keys, such as Brave), the clip is recorded instead and the server works out
// the words. Either way nothing is ever sent by itself. Chrome sends its audio to Google; the server sends it to Groq.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, dismiss, notify } from "./store.js";
import { html, Icon } from "./ui.js";

/** The browser's recognizer, looked up when used (so a page can stand one in), or undefined where there is none. */
const Recognizer = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

/** Where this browser dictates, kept between visits: `localStorage` holds strings, and nothing else. */
const MODE_KEY = "pocket.dictation";

/** Whether the server recognises this browser's clips: after its own recogniser failed to reach its servers, or where it
 * has none at all. */
const serverMode = () => {
    try {
        return localStorage.getItem(MODE_KEY) === "server";
    } catch {
        return false;
    }
};

const keepMode = (server) => {
    try {
        localStorage.setItem(MODE_KEY, server ? "server" : "browser");
    } catch {
        // A browser that keeps nothing: the next dictation asks its own recogniser again.
    }
};

/** Whether this browser can record a clip for the server: a recorder, a microphone, and a page browsers give it to. */
const recordable = () =>
    globalThis.isSecureContext !== false &&
    typeof MediaRecorder === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

/** Whether the mic can work here: a recognizer of the browser's own or a recorder for the server, and a page browsers
 * give the microphone to (https, or this machine). */
export const voiceAvailable = () =>
    globalThis.isSecureContext !== false && (typeof Recognizer() === "function" || recordable());

/** What each of the recognizer's errors means for the person; those not here are named as they are. */
const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
    "service-not-allowed": "This browser does not allow dictation here.",
    "no-speech": "No speech heard. Tap the mic and try again.",
    "audio-capture": "No microphone found.",
    network: "Dictation needs the network: the browser recognises speech on its own servers.",
    "language-not-supported": "This browser cannot recognise your language.",
};

/** What this browser records for the server: Opus in WebM where it has it, MP4 (Safari) where it has not. */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** What this browser records, the best of what it supports: empty leaves the choice to the browser itself. */
function recordingType() {
    const supports = (type) =>
        typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(type);

    return TYPES.find(supports) ?? "";
}

/** The longest clip the server takes: a minute of speech is a paragraph, and the free tier counts every second. */
const MAX_SECONDS = 120;

/** A press shorter than this is a tap, not a person speaking, and sends no clip. */
const MIN_SECONDS = 0.4;

/** What a microphone the browser would not open means for the person. */
function micProblem(error) {
    const name = error?.name ?? "";

    if (name === "NotAllowedError" || name === "SecurityError") {
        return ERRORS["not-allowed"];
    }

    if (name === "NotFoundError" || name === "OverconstrainedError") {
        return ERRORS["audio-capture"];
    }

    if (name === "NotReadableError") {
        return "The microphone is busy in another app.";
    }

    return `The microphone did not open: ${error?.message ?? error}`;
}

/** The dictation that listens now: one at a time, in the whole app. */
let current = null;
/**
 * The boxes that can dictate, newest last. The shortcut (Alt+V) dictates into PiP's while it shows (its box is `top`),
 * else into the newest in the page: one gone for now (view only, someone else's turn) is passed over.
 */
const boxes = [];

/** Alt+V: start or stop dictation in PiP's box or the newest; false when no box can. */
export function toggleDictation() {
    const shown = (each) => each.box.current?.isConnected === true;
    const box = boxes.findLast((each) => each.top && shown(each)) ?? boxes.findLast(shown);

    if (!box || !voiceAvailable()) {
        return false;
    }

    box.toggle();

    return true;
}

/**
 * How long the starts of `a` and `b` agree, and their ends, each on its own: an edit that repeats what is beside it
 * ("H" typed before "Hello") fits both ways, and either way it is outside what agrees.
 */
function common(a, b) {
    let head = 0;

    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }

    let tail = 0;

    while (
        tail < a.length &&
        tail < b.length &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }

    return { head, tail };
}

/** Words heard, put between what the box has before and after them, with a space where words would touch. */
function join(before, words, after) {
    if (words === "") {
        return { value: before + after, at: before.length };
    }

    const start = /\S$/.test(before) ? " " : "";
    const end = /^[^\s.,;:!?)]/.test(after) ? " " : "";
    // A sentence's first word starts with a capital, as the browser leaves some in lower case.
    const capital = before.trim() === "" || /[.!?]\s*$/.test(before);
    const said = capital ? words[0].toUpperCase() + words.slice(1) : words;
    const head = before + start + said;

    return { value: head + end + after, at: head.length };
}

/**
 * Dictation into a textarea (`box`, a ref). `onText(value, caret)` hears each change, as typing does, so the box's own
 * draft saving keeps it. Words go in at the caret while the box has the focus, and after its text when it does not.
 * Returns whether it listens, and `toggle` and `stop` (`stop(true)` drops words not yet settled: for sending, leaving).
 * `top` marks PiP's box, which takes Alt+V while it shows.
 */
export function useDictation(box, onText, { top = false } = {}) {
    const [listening, setListening] = useState(false);
    const hear = useRef(onText);
    const self = useRef(null);

    hear.current = onText;

    if (self.current === null) {
        self.current = {
            box,
            top,
            recognition: null,
            /** The clip being recorded for the server, while it records. */
            recorder: null,
            /** The microphone on its way to opening, before there is a recorder. */
            opening: false,
            /** Whether what is being recorded or heard is thrown away rather than used. */
            dropped: false,
            /** Held down now, or let go before the microphone opened. */
            pressed: undefined,
            /** The timer that stops a clip that nobody stopped. */
            timer: null,
            /** Stop listening: `drop` throws away what is not settled yet, and anything heard after. */
            stop(drop = false) {
                const recorder = this.recorder;

                if (recorder) {
                    // `onstop` sends the clip, or drops it, and lets the microphone go.
                    this.dropped = drop;
                    clearTimeout(this.timer);
                    this.timer = null;
                    setListening(false);
                    recorder.stop();

                    return;
                }

                const recognition = this.recognition;

                if (!recognition) {
                    return;
                }

                this.recognition = null;
                setListening(false);

                if (current === this) {
                    current = null;
                }

                if (drop) {
                    recognition.onresult = null;
                    recognition.abort();
                } else {
                    recognition.stop();
                }
            },
            start() {
                const element = box.current;
                const Recognition = Recognizer();

                if (!element || this.opening) {
                    return;
                }

                // No recogniser of its own, or one that cannot reach its servers: record the clip, and let the server
                // work out the words.
                if (typeof Recognition !== "function" || serverMode()) {
                    this.record(element);

                    return;
                }

                current?.stop();
                current = this;

                const recognition = new Recognition();

                recognition.lang = navigator.language || "en-US";
                recognition.continuous = true;
                recognition.interimResults = true;
                this.recognition = recognition;

                // What the box had around the words, the results already in it, and the box as dictation left it: its
                // text and its selection. `pending` is the first result not settled yet, and `span` where its words are.
                let base = null;
                let from = 0;
                let seen = 0;
                let written = "";
                let selection = [0, 0];
                let pending = 0;
                let span = [0, 0];
                // The person moved on while words were still coming: those finish where they are, then words go where
                // the person is.
                let moving = false;

                const focused = () => document.activeElement === element;
                const selected = () => [element.selectionStart, element.selectionEnd];

                const rebase = () => {
                    const at = focused() ? element.selectionStart : element.value.length;
                    const end = focused() ? element.selectionEnd : at;

                    base = { before: element.value.slice(0, at), after: element.value.slice(end) };
                    from = seen;
                    moving = false;
                };

                rebase();
                written = element.value;
                selection = selected();

                /**
                 * Typed into, or the caret moved, since the words last went in. Outside the words still coming, those
                 * finish where they are, around what the person did; on them, the person's edit wins, and what is heard
                 * next goes where the caret is.
                 */
                const changed = () => {
                    const value = element.value;
                    const [s, e] = span;
                    const { head, tail } = common(written, value);
                    // Where the edit was in what dictation wrote: after the words coming (they are in the start that
                    // agrees), or before them (in the end that agrees).
                    const after = value === written || head >= e;
                    const before = !after && written.length - tail <= s;

                    if (pending >= seen || !(after || before)) {
                        rebase();

                        return;
                    }

                    const shift = before ? value.length - written.length : 0;

                    base = { before: value.slice(0, s + shift), after: value.slice(e + shift) };
                    from = pending;
                    moving = true;
                };

                recognition.onresult = (event) => {
                    const results = event.results;

                    if (
                        element.value !== written ||
                        (focused() && selected().some((at, index) => at !== selection[index]))
                    ) {
                        changed();
                    }

                    // What is settled, then what may still change, from the first result not settled on.
                    let first = from;

                    while (first < results.length && results[first].isFinal) {
                        first++;
                    }

                    const said = (start, end) => {
                        const words = [];

                        for (let index = start; index < end; index++) {
                            words.push(results[index][0].transcript.trim());
                        }

                        return words.filter(Boolean).join(" ");
                    };

                    const settled = said(from, first);
                    const coming = said(first, results.length);
                    const all = [settled, coming].filter(Boolean).join(" ");
                    const { value, at } = join(base.before, all, base.after);
                    // Where the words still coming start: after the settled ones and a space, or where all start.
                    const start =
                        settled === ""
                            ? base.before.length + (all !== "" && /\S$/.test(base.before) ? 1 : 0)
                            : join(base.before, settled, base.after).at + (coming === "" ? 0 : 1);
                    // Where the text after the words ends up: the person's selection there moves with it.
                    const was = element.value.length - base.after.length;
                    const now = value.length - base.after.length;
                    const person = selected();

                    seen = results.length;
                    pending = first;
                    span = [start, at];
                    written = value;
                    element.value = value;

                    if (focused()) {
                        const place = (point) =>
                            point >= was ? point + now - was : Math.min(point, now);

                        if (moving) {
                            element.setSelectionRange(place(person[0]), place(person[1]));
                        } else {
                            element.setSelectionRange(at, at);
                        }
                    }

                    selection = selected();
                    hear.current(value, moving ? selection[1] : at);

                    // The words left behind are all settled: what comes next goes where the person is.
                    if (moving && first === results.length) {
                        rebase();
                    }
                };

                recognition.onerror = (event) => {
                    // Aborted is this app's own doing; no speech for a while ends a quiet dictation, said once.
                    if (event.error === "aborted") {
                        return;
                    }

                    // This recogniser cannot reach its own servers, which a Chromium build without Google's keys
                    // does every time. The server takes the next clip, and every one after it.
                    if (event.error === "network" && recordable()) {
                        keepMode(true);
                        notify(
                            "error",
                            "The browser's dictation has no network. This browser now records the clip " +
                                "and the server works out the words: hold the mic to talk.",
                        );

                        return;
                    }

                    const level = event.error === "no-speech" ? "info" : "error";

                    notify(level, ERRORS[event.error] ?? `Dictation stopped: ${event.error}.`);
                };

                recognition.onend = () => {
                    if (this.recognition === recognition) {
                        this.stop();
                    }
                };

                try {
                    recognition.start();
                    setListening(true);
                } catch (error) {
                    this.recognition = null;
                    current = null;
                    notify("error", `Dictation did not start: ${error.message ?? error}`);
                }
            },
            /** Record a clip for the server, which works out the words once the person lets go. */
            async record(element) {
                let stream;

                this.opening = true;

                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                        },
                    });
                } catch (error) {
                    this.opening = false;
                    notify("error", micProblem(error));

                    return;
                }

                this.opening = false;

                // The person let go before the microphone opened: there is nothing to send.
                if (this.pressed === false) {
                    this.pressed = undefined;
                    stream.getTracks().forEach((track) => track.stop());
                    notify("info", "Hold the mic while you speak, then let go to send.");

                    return;
                }

                const started = Date.now();
                const type = recordingType();
                const chunks = [];
                let recorder;

                try {
                    recorder = new MediaRecorder(
                        stream,
                        type === "" ? undefined : { mimeType: type },
                    );
                } catch {
                    recorder = new MediaRecorder(stream);
                }

                recorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        chunks.push(event.data);
                    }
                };

                recorder.onstop = () => {
                    stream.getTracks().forEach((track) => track.stop());
                    clearTimeout(this.timer);
                    this.timer = null;
                    this.recorder = null;
                    setListening(false);

                    if (current === this) {
                        current = null;
                    }

                    const dropped = this.dropped;

                    this.dropped = false;

                    if (dropped) {
                        return;
                    }

                    if ((Date.now() - started) / 1000 < MIN_SECONDS) {
                        notify("info", "Hold the mic while you speak, then let go to send.");

                        return;
                    }

                    this.transcribe(
                        element,
                        new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
                    );
                };

                this.recorder = recorder;
                this.dropped = false;
                current = this;
                setListening(true);
                recorder.start();
                this.timer = setTimeout(() => this.stop(), MAX_SECONDS * 1000);
            },
            /** Send one clip, and put the words it holds where the caret is (after the text, when the box has no focus). */
            async transcribe(element, clip) {
                const notice = notify("info", "Working out the words…");
                let words;

                try {
                    ({ text: words } = await api("voice/transcribe", clip));
                } catch (error) {
                    dismiss(notice);
                    notify("error", error.message ?? String(error));

                    return;
                }

                dismiss(notice);
                const said = String(words ?? "").trim();

                if (said === "") {
                    notify("info", ERRORS["no-speech"]);

                    return;
                }

                const focused = document.activeElement === element;
                const at = focused ? element.selectionStart : element.value.length;
                const end = focused ? element.selectionEnd : at;
                const { value, at: caret } = join(
                    element.value.slice(0, at),
                    said,
                    element.value.slice(end),
                );

                element.value = value;

                if (focused) {
                    element.setSelectionRange(caret, caret);
                }

                hear.current(value, caret);
            },
            /** Hold to talk: the press opens the microphone, and letting go stops it and sends the clip. */
            press() {
                if (this.recorder || this.opening || this.recognition) {
                    return;
                }

                this.pressed = true;
                this.start();
            },
            release() {
                this.pressed = false;

                if (this.recorder) {
                    this.stop();
                }
            },
            /** Whether this browser dictates by holding the mic down, rather than by tapping it to start and stop. */
            hold() {
                return typeof Recognizer() !== "function" || serverMode();
            },
            toggle() {
                if (this.recognition || this.recorder) {
                    this.stop();
                } else {
                    this.pressed = undefined;
                    this.start();
                }
            },
        };
    }

    const dictation = self.current;

    // The newest box takes the shortcut while it shows; leaving it ends dictation, as does the tab going out of sight.
    useEffect(() => {
        const hidden = () => document.hidden && dictation.stop();

        boxes.push(dictation);
        document.addEventListener("visibilitychange", hidden);

        return () => {
            boxes.splice(boxes.indexOf(dictation), 1);
            document.removeEventListener("visibilitychange", hidden);
            dictation.stop(true);
        };
    }, []);

    return {
        listening,
        hold: () => dictation.hold(),
        toggle: () => dictation.toggle(),
        press: () => dictation.press(),
        release: () => dictation.release(),
        stop: (drop) => dictation.stop(drop),
    };
}

/**
 * The mic: starts dictation, and while it listens, stops it. Where dictation goes to the server it is held down instead:
 * the press records, and letting go sends the clip. None where the browser can neither recognise nor record.
 */
export function MicButton({ dictation, class: className = "", size = 17, part }) {
    if (!voiceAvailable()) {
        return null;
    }

    const { listening, toggle, press, release } = dictation;
    const hold = dictation.hold();

    const down = (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }

        event.preventDefault();

        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
            // A pointer this page cannot capture: the press counts anyway.
        }

        press();
    };

    const up = (event) => {
        try {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        } catch {
            // Nothing was captured, so there is nothing to let go.
        }

        release();
    };

    return html`<button
        type="button"
        class=${`icon-button mic-button ${listening ? "listening" : ""} ${className}`}
        data-part=${part}
        data-hold=${hold ? "true" : undefined}
        aria-label="Dictate"
        aria-pressed=${listening ? "true" : "false"}
        title=${title(hold, listening)}
        onMouseDown=${(event) => event.preventDefault()}
        onPointerDown=${hold ? down : undefined}
        onPointerUp=${hold ? up : undefined}
        onPointerCancel=${hold ? up : undefined}
        onContextMenu=${hold ? (event) => event.preventDefault() : undefined}
        onClick=${hold ? undefined : toggle}
    >
        <${Icon} name="mic" size=${size} />
    </button>`;
}

/** What the mic says it does: held down, or tapped, and what happens while it listens. */
function title(hold, listening) {
    if (hold) {
        return listening
            ? "Recording: let go to send (Alt+V stops)"
            : "Hold to dictate (Alt+V starts)";
    }

    return listening ? "Listening: tap to stop (Alt+V)" : "Dictate (Alt+V)";
}
