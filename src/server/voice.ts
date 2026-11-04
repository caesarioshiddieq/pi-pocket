/**
 * Dictation recognised on the server: a clip the browser recorded goes to Groq's free speech-to-text tier, and its
 * words come back. The owner's key is read from the data folder for each clip. It is never logged, and never reaches a
 * browser: a route answers with the words alone.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { homePath } from "./paths.ts";

/** The most one clip may be: Groq takes 25 MB, and nobody dictates into a message box for longer than this. */
export const MAX_CLIP = 20 * 1024 * 1024;

/** Groq's endpoint, which takes what OpenAI's does: one multipart form, with the clip and the model. */
const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Whisper large v3 turbo, with the slower model after it in case the free tier stops offering the turbo one. */
const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

/** The file name a clip goes by: Groq reads the format from it. */
const NAMES: Record<string, string> = {
    "audio/webm": "clip.webm",
    "audio/ogg": "clip.ogg",
    "audio/mp4": "clip.mp4",
    "audio/wav": "clip.wav",
    "audio/x-wav": "clip.wav",
};

/** Where the owner puts the key, written by them, readable by nobody else. */
const keyPath = () => homePath(join(dataDir(), "groq-api-key"));

/** The owner's key, or an error that says how to give this copy of Pi Pocket one. */
async function key(): Promise<string> {
    let text: string;

    try {
        text = await readFile(join(dataDir(), "groq-api-key"), "utf8");
    } catch {
        throw new HttpError(503, `Dictation on the server needs a Groq key in ${keyPath()}.`);
    }

    const trimmed = text.trim();

    if (trimmed === "") {
        throw new HttpError(503, `The key file ${keyPath()} is empty.`);
    }

    return trimmed;
}

/** What Groq said went wrong, in one line a person can read. */
async function said(response: Response): Promise<string> {
    const text = await response.text();

    try {
        const body = JSON.parse(text) as { error?: { message?: unknown } };
        const message = body.error?.message;

        if (typeof message === "string" && message.trim() !== "") {
            return message.trim().slice(0, 300);
        }
    } catch {
        // Not JSON: what it sent is the answer.
    }

    return text.trim().slice(0, 300) || `Groq answered ${response.status}.`;
}

/** The status this app answers with, and the words: a key or a quota is this copy's problem, a bad clip is the person's. */
function refusal(status: number, reason: string): HttpError {
    if (status === 401 || status === 403) {
        return new HttpError(503, `Groq refused the key in ${keyPath()}: ${reason}`);
    }

    if (status === 429) {
        return new HttpError(429, `Groq's free quota is used up for now: ${reason}`);
    }

    if (status === 413) {
        return new HttpError(413, "That clip is too long for Groq.");
    }

    return new HttpError(502, `Groq could not transcribe that: ${reason}`);
}

/**
 * The words in one clip. `type` is what the browser recorded, such as `audio/webm`. Throws an HttpError whose message a
 * person can act on: a missing key, a refused key, a spent quota, or a clip it could not read.
 */
export async function transcribe(clip: Buffer, type: string): Promise<string> {
    if (clip.length === 0) {
        throw new HttpError(400, "The clip was empty.");
    }

    const apiKey = await key();
    let reason = "";

    for (const model of MODELS) {
        const form = new FormData();

        form.set("file", new Blob([new Uint8Array(clip)], { type }), NAMES[type] ?? "clip.webm");
        form.set("model", model);
        form.set("response_format", "json");
        form.set("temperature", "0");

        let response: Response;

        try {
            response = await fetch(ENDPOINT, {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}` },
                body: form,
                signal: AbortSignal.timeout(120_000),
            });
        } catch (error) {
            throw new HttpError(502, `Groq could not be reached: ${describe(error)}`);
        }

        if (response.ok) {
            const body = (await response.json()) as { text?: unknown };
            const text = typeof body.text === "string" ? body.text.trim() : "";

            if (text === "") {
                throw new HttpError(
                    422,
                    "No words in that clip. Try again, closer to the microphone.",
                );
            }

            return text;
        }

        reason = await said(response);

        // A model the free tier no longer offers, or a clip it cannot read: the next model may still do. Anything
        // else stops here, with what Groq said.
        if (response.status !== 400 && response.status !== 404) {
            throw refusal(response.status, reason);
        }
    }

    throw new HttpError(422, `Groq could not read that clip: ${reason}`);
}
