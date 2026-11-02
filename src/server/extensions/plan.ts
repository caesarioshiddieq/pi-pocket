/**
 * Plan mode lets Pi read and explore but change nothing, so it proposes a plan for people to approve first. While a
 * session is in plan mode, Pi may read files, run read-only shell commands, publish artifacts, look at pages in the
 * browser, run codemode scripts (whose calls get the same checks), and call tools their extension marks read-only;
 * everything else is blocked with a note saying why. This keeps Pi to planning; it is not a security boundary: Lancet
 * Guard is. Programs that people configured to run on their own, such as a git diff driver or file system monitor, run
 * as they would for anyone.
 */
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
    defineExtension,
    hook,
    section,
    type ToolExecutionApi,
    ToolTask,
} from "@earendil-works/pi-durable";
import { PlanDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";

const PLANNING = `Plan mode is on. Read and explore, then propose a plan; change nothing yet. You can use read, artifact, artifact_inline, the browser to look at pages (not to click, type, or run scripts in them), and bash for simple read-only commands such as ls, cat, grep, find, git status/log/diff/show/hash-object, and sed -n for a line range. A 2>/dev/null, 2>&1 or >/dev/null redirection is fine, and a glob may name the files an argument reads; any other redirect, variable, or command substitution is not. Tools marked read-only also run. Subagents inherit plan mode and can explore under the same restrictions. Writing, editing, and other commands are blocked until a person approves the plan. End your answer with the plan as a short numbered list.`;

/** Tools that change nothing, or whose own calls are checked in plan mode (codemode's, and a subagent's in its own plan mode). */
const ALWAYS_ALLOWED = new Set([
    "read",
    "artifact",
    "artifact_inline",
    "design_preview",
    "tool_search",
    "codemode",
    "subagent",
    "ask",
]);
/** What the browser may do in plan mode: look at pages, not act on them. */
const BROWSER_LOOKS = new Set([
    "navigate",
    "snapshot",
    "screenshot",
    "console",
    "back",
    "forward",
    "reload",
    "scroll",
    "wait",
    "viewport",
    "hover",
]);

type ArgsCheck = (args: readonly string[]) => boolean;
const anyArgs: ArgsCheck = () => true;

/**
 * Refuses arguments that turn on any of these options: single letters (also inside `-abc`) or long names. Long names
 * also count shortened, as getopt and git accept them: `--outp` is `--output`.
 */
function refuses(letters: string, ...long: string[]): ArgsCheck {
    return (args) =>
        !args.some((arg) => {
            if (arg.startsWith("--")) {
                const name = arg.split("=", 1)[0]!;

                return name.length > 2 && long.some((refused) => refused.startsWith(name));
            }

            return /^-./.test(arg) && [...letters].some((letter) => arg.slice(1).includes(letter));
        });
}

const GIT_READS = new Set([
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "describe",
    "shortlog",
    "grep",
    "hash-object",
]);

/** Git commands that only read, without options that write a file or run a program (a pager, an external diff). */
const gitReads: ArgsCheck = (args) => {
    let at = 0;

    while (args[at] === "--no-pager") {
        at++;
    }

    if (!GIT_READS.has(args[at] ?? "")) {
        return false;
    }

    // `hash-object` only reads, until `-w` writes the object it just made.
    if (args[at] === "hash-object" && !refuses("w")(args.slice(at + 1))) {
        return false;
    }

    return refuses("O", "--output", "--ext-diff", "--open-files-in-pager")(args.slice(at + 1));
};

/** `find` actions that delete, write, or run something. */
const FIND_ACTIONS = new Set([
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
]);

/** Options that keep `sed` reading: quiet, extended regular expressions, separate files. */
const SED_OPTIONS = new Set(["-n", "-E", "-r", "-s", "--quiet", "--silent", "--regexp-extended", "--separate"]);
/** The options that keep sed from printing every line. */
const SED_QUIET = new Set(["-n", "--quiet", "--silent"]);
/** A line range and `p`: `5p`, `1,120p`, `1,$p`, `$p`. Nothing else is a plain print. */
const SED_RANGE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

/** Commands that only read, each with a check of the arguments that would make it write or run something else. */
const READERS: Readonly<Record<string, ArgsCheck>> = {
    cat: anyArgs,
    cd: anyArgs,
    cmp: anyArgs,
    column: anyArgs,
    cut: anyArgs,
    df: anyArgs,
    // `-l` starts `pr` to paginate the output.
    diff: refuses("l", "--paginate"),
    dirname: anyArgs,
    basename: anyArgs,
    du: anyArgs,
    echo: anyArgs,
    false: anyArgs,
    fd: refuses("xX", "--exec", "--exec-batch"),
    // Compiling a magic file writes one.
    file: refuses("C", "--compile"),
    find: (args) => !args.some((arg) => FIND_ACTIONS.has(arg)),
    git: gitReads,
    grep: anyArgs,
    head: anyArgs,
    id: anyArgs,
    jq: anyArgs,
    ls: anyArgs,
    md5sum: anyArgs,
    nl: anyArgs,
    printenv: anyArgs,
    // `printf -v name` and `test -v name` evaluate a subscript in the name, which can run a command: `a[$(…)]`.
    printf: (args) => !(args[0] ?? "").startsWith("-v"),
    pwd: anyArgs,
    readlink: anyArgs,
    realpath: anyArgs,
    // A hostname program runs to fill in hyperlinks.
    rg: refuses("", "--pre", "--hostname-bin"),
    // `sed -n '1,120p' file` prints lines. Only a plain range with a trailing `p` passes: every way
    // sed writes a file (`-i`, or a `w`/`W`/`e` command inside the script) needs another shape.
    sed: (args) => {
        const options = args.filter((arg) => arg.startsWith("-"));
        const rest = args.filter((arg) => !arg.startsWith("-"));
        const quiet = options.some((option) => SED_QUIET.has(option));
        const allowed = options.every((option) => SED_OPTIONS.has(option));

        // Without `-n` sed prints every line as well as the range: still a read, but not the plain shape this allows.
        return allowed && quiet && rest.length > 0 && SED_RANGE.test(rest[0]!);
    },
    sha1sum: anyArgs,
    sha256sum: anyArgs,
    // A compress program runs when sort spills to temporary files.
    sort: refuses("o", "--output", "--compress-program"),
    stat: anyArgs,
    tail: anyArgs,
    test: (args) => !args.includes("-v"),
    tr: anyArgs,
    // With -H, -R writes an HTML file into each folder.
    tree: refuses("oR"),
    true: anyArgs,
    uname: anyArgs,
    // A second operand is where uniq writes. After `--` every word is an operand, even `--include=out`; before it,
    // `-` names standard input.
    uniq: (args) => {
        const end = args.indexOf("--");
        const before = end < 0 ? args : args.slice(0, end);
        const after = end < 0 ? [] : args.slice(end + 1);

        return before.filter((arg) => arg === "-" || !arg.startsWith("-")).length + after.length <= 1;
    },
    wc: anyArgs,
    which: anyArgs,
    whoami: anyArgs,
};

/**
 * The simple commands of a command line, as words: split at `|`, `||`, `&&`, `;`, and new lines, with quotes and
 * backslashes resolved the way bash does. Undefined for anything that is more than plain words: redirects,
 * substitutions, variables, subshells, background jobs, line continuations, or an unfinished quote. A glob
 * (`*`, `?`, `[…]`) stays part of its word: it names files, and `readOnlyCommand` refuses one as a command name.
 */
export function commandWords(command: string): string[][] | undefined {
    const items = commandItems(command);

    return items === undefined ? undefined : items.map((words) => words.map((item) => item.text));
}

/**
 * A word a glob may expand into: the value of a long option, as in `--include=*.ts`. The expansion changes the value,
 * never the option name and never a second word, so no reader can turn it into an option that writes.
 */
const GLOB_VALUE = /^--[a-z0-9-]+=/;

/** What ends a redirection in bash: a plain space or tab, a newline, a pipe, a list operator, `)`. Not `\r`. */
const SEPARATOR = /^[ \t\n|;&)]$/;
const BLANK = /^[ \t]$/;

/** One word of a command line: the text a reader sees, whether an unquoted glob built it, and whether quoting did. */
interface Item {
    text: string;
    glob: boolean;
    quoted: boolean;
}

/** The tokenizer both views use; `glob` tells a name a glob may expand from a quoted literal one. */
function commandItems(command: string): Item[][] | undefined {
    const commands: Item[][] = [[]];
    let word: string | undefined;
    let glob = false;
    let quoted = false;
    let quote: "'" | '"' | undefined;

    const add = (text: string) => {
        word = (word ?? "") + text;
    };

    const endWord = () => {
        if (word !== undefined) {
            commands.at(-1)!.push({ text: word, glob, quoted });
        }

        word = undefined;
        glob = false;
        quoted = false;
    };

    const endCommand = () => {
        endWord();
        commands.push([]);
    };

    for (let at = 0; at < command.length; at++) {
        const char = command[at]!;
        const next = command[at + 1];

        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                quoted = true;
                add(char);
            }
        } else if (quote === '"') {
            if (char === '"') {
                quote = undefined;
            } else if (char === "$" || char === "`") {
                return undefined;
            } else if (char !== "\\") {
                quoted = true;
                add(char);
            }
            // Inside double quotes a backslash escapes only a quote or another backslash; before anything else it stays.
            else if (next === '"' || next === "\\") {
                add(command[++at]!);
            } else if (next === "\n") {
                return undefined;
            } else {
                add(char);
            }
        } else if (char === "'" || char === '"') {
            quote = char;
            quoted = true;
            add("");
        } else if (char === "\\") {
            if (next === undefined || next === "\n") {
                return undefined;
            }

            quoted = true;
            add(command[++at]!);
        } else if (char === "\n" || char === ";") {
            endCommand();
        } else if (char === "|" || char === "&") {
            // A single `&` sends a job to the background.
            if (char === "&" && next !== "&") {
                return undefined;
            }

            if (next === char) {
                at++;
            }

            endCommand();
        } else if (char === " " || char === "\t") {
            endWord();
        } else if (char === ">" || char === "<") {
            // A plain, unquoted run of digits before `>` is a file descriptor: `2>/dev/null`. A quoted `1` is a
            // file name the reader sees, so it stays a word.
            const descriptor = word !== undefined && !quoted && /^\d+$/.test(word);

            if (!descriptor) {
                endWord();
            }

            word = undefined;

            const input = char === "<";

            if (!input && next === ">") {
                at++;
            }

            while (BLANK.test(command[at + 1] ?? "")) {
                at++;
            }

            if (!input && command[at + 1] === "&") {
                const fd = command[at + 2];

                // `>&1review` sends the stream to a file named `1review`: the digit must end the redirection.
                const after = command[at + 3];

                if (fd === undefined || !/[0-9]/.test(fd) || (after !== undefined && !SEPARATOR.test(after))) {
                    return undefined;
                }

                at += 2;
                continue;
            }

            // The target must be exactly `/dev/null`, and it must end the redirection: `>/dev/null.review` and
            // `>/dev/null".review"` name a file this reader cannot see.
            const start = at + 1;
            let end = start;

            while (end < command.length && /[A-Za-z0-9/._-]/.test(command[end]!)) {
                end++;
            }

            const after = command[end];

            if (command.slice(start, end) !== "/dev/null" || (after !== undefined && !SEPARATOR.test(after))) {
                return undefined;
            }

            at = end - 1;
        } else if (char === "`" || char === "$" || char === "(" || char === ")" || char === "{" || char === "}" || char === "!" || char === "#") {
            return undefined;
        } else {
            if (char === "*" || char === "?" || char === "[") {
                glob = true;
            }

            add(char);
        }
    }

    if (quote !== undefined) {
        return undefined;
    }

    endWord();

    return commands.filter((words) => words.length > 0);
}

/** Whether a shell command only reads: every command in it is a known reader, with arguments that keep it one. */
export function readOnlyCommand(command: string): boolean {
    const commands = commandItems(command);

    if (commands === undefined || commands.length === 0) {
        return false;
    }

    return commands.every(([first, ...rest]) => {
        const name = first?.text ?? "";

        if (!Object.hasOwn(READERS, name)) {
            return false;
        }

        // `*` as the command word runs the first file it matches.
        if (first!.glob || !READERS[name]!(rest.map((item) => item.text))) {
            return false;
        }

        // A glob in an argument expands to names this reader cannot see: one may start with `-` and turn into an
        // option, and for `uniq`, `find`, `diff`, `file`, `sed` or `sort` that writes or runs. Only an option
        // value may hold one, and only before `--`: after `--` every word is a file name, and `uniq` writes the
        // second one. A quoted pattern stays literal for everyone.
        const end = rest.findIndex((item) => item.text === "--");

        return rest.every(
            (item, at) => !item.glob || (GLOB_VALUE.test(item.text) && (end < 0 || at < end)),
        );
    });
}

/**
 * Why a call may not run in plan mode, or undefined when it may. `readOnly`: the tool's extension marks it read-only
 * (`annotations: { readOnlyHint: true }`, as in Pi's tool definitions).
 */
export function blockedInPlanMode(
    tool: string,
    args: Record<string, unknown>,
    readOnly = false,
): string | undefined {
    if (ALWAYS_ALLOWED.has(tool) || readOnly) {
        return undefined;
    }

    // Nor does reading what a background task printed, or stopping it; starting one runs a command.
    if (tool === "background" && args.action !== "start") {
        return undefined;
    }

    // A data: page is a page Pi writes, scripts and all: looking at pages means pages that exist.
    const scripted =
        tool === "browser" &&
        args.action === "navigate" &&
        /^\s*data:/i.test(String(args.url ?? ""));

    if (tool === "browser" && BROWSER_LOOKS.has(String(args.action)) && !scripted) {
        return undefined;
    }

    if (tool === "bash" && typeof args.command === "string" && readOnlyCommand(args.command)) {
        return undefined;
    }

    const what =
        tool === "bash"
            ? "This command is not a simple read-only one"
            : tool === "browser"
              ? `The browser's ${String(args.action)} can change things on the page`
              : `The ${tool} tool can change things`;

    return `Plan mode is on: ${what}, so it is blocked. Keep exploring with read and read-only commands, then propose your plan; a person approves it before anything changes.`;
}

export default function createPlan(_host: PocketHost) {
    return defineExtension({
        name: "pocket-plan",
        sections: [
            section("plan_mode", async (input, context) =>
                (await input.read.snapshot(PlanDoc, input.conversationId, context))?.on
                    ? PLANNING
                    : undefined,
            ),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if ((await api.snapshot(PlanDoc, api.conversationId, context))?.on !== true) {
                        return undefined;
                    }

                    // HookApi omits agent, but ToolTask supplies its phase runtime and codemode preserves it.
                    // Use that same resolved snapshot, not the live registry: wrappers and reloads can differ.
                    const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
                    const tool = (await runtime.agent?.(context))?.tools.find(
                        (tool) => tool.name === call.name,
                    ) as { annotations?: ToolAnnotations } | undefined;
                    // A built-in tool's hint can only come from a wrap, which the owner never sees as read-only.
                    const reason = blockedInPlanMode(
                        call.name,
                        call.arguments as Record<string, unknown>,
                        !BUILT_IN_TOOLS.has(call.name) && tool?.annotations?.readOnlyHint === true,
                    );

                    return reason === undefined ? undefined : { block: reason };
                },
            }),
        ],
    });
}
