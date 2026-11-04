import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transcribe } from "../src/server/voice.ts";

/** A data folder holding a Groq key, which is all of Pi Pocket's own that dictation reads. */
async function dataFolder(text = "gsk_test"): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "pocket-voice-"));

    await writeFile(join(folder, "groq-api-key"), text);

    return folder;
}

/** Answer each request with the next status and body in the list, and give back what was asked for. */
function stubFetch(answers: { status: number; body: string }[]) {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const original = globalThis.fetch;
    const queue = [...answers];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push({ url: String(url), init });

        const answer = queue.shift() ?? { status: 500, body: "{}" };

        return new Response(answer.body, {
            status: answer.status,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;

    return {
        asked,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

/** Run `body` with `folder` as Pi Pocket's data folder. */
async function withFolder<T>(folder: string, body: () => Promise<T>): Promise<T> {
    const before = process.env.PI_POCKET_DIR;

    process.env.PI_POCKET_DIR = folder;

    try {
        return await body();
    } finally {
        if (before === undefined) {
            delete process.env.PI_POCKET_DIR;
        } else {
            process.env.PI_POCKET_DIR = before;
        }
    }
}

test("a clip goes to Groq as one multipart form, and its words come back trimmed", async () => {
    const folder = await dataFolder();
    const stub = stubFetch([{ status: 200, body: JSON.stringify({ text: "  halo dunia  " }) }]);

    try {
        const words = await withFolder(folder, () =>
            transcribe(Buffer.from("clip bytes"), "audio/webm;codecs=opus"),
        );

        assert.equal(words, "halo dunia");
        assert.equal(stub.asked.length, 1);
        assert.equal(stub.asked[0]?.url, "https://api.groq.com/openai/v1/audio/transcriptions");

        const form = stub.asked[0]?.init?.body as FormData;

        assert.equal(form.get("model"), "whisper-large-v3-turbo");
        assert.equal(form.get("response_format"), "json");
        assert.equal((form.get("file") as File).name, "clip.webm");
        assert.equal(
            (stub.asked[0]?.init?.headers as Record<string, string>).authorization,
            "Bearer gsk_test",
        );
    } finally {
        stub.restore();
    }
});

test("a model the free tier drops leaves the next one to try", async () => {
    const folder = await dataFolder();
    const stub = stubFetch([
        { status: 404, body: JSON.stringify({ error: { message: "model not found" } }) },
        { status: 200, body: JSON.stringify({ text: "selamat pagi" }) },
    ]);

    try {
        const words = await withFolder(folder, () => transcribe(Buffer.from("x"), "audio/webm"));

        assert.equal(words, "selamat pagi");
        assert.deepEqual(
            stub.asked.map((one) => (one.init?.body as FormData).get("model")),
            ["whisper-large-v3-turbo", "whisper-large-v3"],
        );
    } finally {
        stub.restore();
    }
});

test("a refused key and a spent quota each say what they are", async () => {
    const folder = await dataFolder();
    const refused = stubFetch([
        { status: 401, body: JSON.stringify({ error: { message: "Invalid API Key" } }) },
    ]);

    try {
        await assert.rejects(
            withFolder(folder, () => transcribe(Buffer.from("x"), "audio/webm")),
            (error: { status: number; message: string }) => {
                assert.equal(error.status, 503);
                assert.match(error.message, /refused the key/);
                assert.match(error.message, /Invalid API Key/);

                return true;
            },
        );
    } finally {
        refused.restore();
    }

    const spent = stubFetch([
        { status: 429, body: JSON.stringify({ error: { message: "rate limit reached" } }) },
    ]);

    try {
        await assert.rejects(
            withFolder(folder, () => transcribe(Buffer.from("x"), "audio/webm")),
            (error: { status: number; message: string }) => {
                assert.equal(error.status, 429);
                assert.match(error.message, /free quota/);

                return true;
            },
        );
    } finally {
        spent.restore();
    }
});

test("no key and no clip are refused before any request is made", async () => {
    const stub = stubFetch([]);

    try {
        await assert.rejects(
            withFolder(join(tmpdir(), "pocket-voice-none"), () =>
                transcribe(Buffer.from("x"), "audio/webm"),
            ),
            /needs a Groq key/,
        );
        await assert.rejects(
            withFolder(await dataFolder(), () => transcribe(Buffer.alloc(0), "audio/webm")),
            /clip was empty/,
        );
        assert.equal(stub.asked.length, 0);
    } finally {
        stub.restore();
    }
});
