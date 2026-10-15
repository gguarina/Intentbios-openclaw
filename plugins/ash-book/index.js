/**
 * OpenClaw plugin: ash-book. Read-only trilogy tools for ash-editor, ash-coldreader and ash-continuity.
 * Phase 3 write path: work_* tools edit ash/<slug> branches on book-runner; locks gate commits;
 * pushes are ash/* only; merging into rewrite needs confirm="merge" after Gustavo says so.
 */
import { ASH_TOOL_NAMES, ASH_WRITE_TOOL_NAMES, executeAshTool } from "./client.mjs";

const branch = { type: "string", description: "Git branch (default: rewrite, the canonical branch)." };
const slug = { type: "string", description: "Work branch slug; the branch is ash/<slug>." };
const file = { type: "string", description: "Repo path, e.g. latex/volume-02-the-resonance-war/chapters/ch07.tex" };
const volume = { type: "integer", minimum: 1, maximum: 3, description: "1 = The Ash, 2 = The Bands, 3 = The Pattern." };

const TOOLS = {
  book_branches: {
    description: "List the trilogy's branches on Origin (name, sha, last commit date and subject), newest first. Use this instead of guessing branch names. rewrite is canonical; main is the old Oct 5 version.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  book_status: {
    description: "Last checkout/locks/build results from book-runner.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  book_locks: {
    description: "Run the canon locks (tools/locks.sh) on a branch. ok=false means the output drifted from prompts/locks-baseline-rewrite.txt. Set post=true to also post the result to #ash-builds.",
    parameters: { type: "object", additionalProperties: false, properties: { branch, post: { type: "boolean" } } },
  },
  book_build: {
    description: "Build the PDFs with latexmk on book-runner, run locks, and post the PDFs plus a summary to #ash-builds (post=false to skip posting). Takes ~10-60 s.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        branch,
        volumes: { type: "array", items: volume, description: "Defaults to [1,2,3]." },
        post: { type: "boolean" },
        withLocks: { type: "boolean" },
      },
    },
  },
  book_file: {
    description: "Read a repo file at a branch, e.g. prompts/series-bible.md, prompts/volume-02-the-resonance-war.md, canon/characters.md, tools/locks.sh, prompts/locks-baseline-rewrite.txt, or a raw .tex file.",
    parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, branch, maxChars: { type: "integer" } }, required: ["path"] },
  },
  book_chapters: {
    description: "List the .tex files (chapters, interludes, front/back matter) on a branch.",
    parameters: { type: "object", additionalProperties: false, properties: { branch } },
  },
  book_chapter: {
    description: "Plain text of one chapter (LaTeX stripped), with word count. Chapters are latex/<volume>/chapters/chNN.tex.",
    parameters: { type: "object", additionalProperties: false, properties: { volume, chapter: { type: "integer", minimum: 1 }, branch, maxChars: { type: "integer" } }, required: ["volume", "chapter"] },
  },
  book_grep: {
    description: "Case-insensitive extended-regex search over the LaTeX sources; returns file, line and text (max 200 hits). Use it to find where a name, object or fact appears before reading chapters.",
    parameters: { type: "object", additionalProperties: false, properties: { pattern: { type: "string" }, volume, branch }, required: ["pattern"] },
  },
  work_start: {
    description: "Start (or reopen) a work branch ash/<slug> off rewrite for one brief or edit. Slug: lowercase-dashes, e.g. fix-typo-b2-ch7.",
    parameters: { type: "object", additionalProperties: false, properties: { slug }, required: ["slug"] },
  },
  work_edit: {
    description: "Exact replace in a chapter file on the work branch. `old` must occur exactly once (include enough context). Files: latex/volume-0N-*/{chapters,interludes,front,back}/*.tex or a volume main.tex. Use raw LaTeX (``quotes'', ---).",
    parameters: { type: "object", additionalProperties: false, properties: { slug, file, old: { type: "string" }, new: { type: "string" } }, required: ["slug", "file", "old", "new"] },
  },
  work_write: {
    description: "Write new prose: mode=append adds text to the end of an existing chapter file; mode=create makes a new .tex file (then add \\input/\\include to the volume main.tex with work_edit). To insert mid-chapter, use work_edit with an anchor.",
    parameters: { type: "object", additionalProperties: false, properties: { slug, file, content: { type: "string" }, mode: { type: "string", enum: ["append", "create"] } }, required: ["slug", "file", "content"] },
  },
  work_diff: {
    description: "Diff of the work branch against rewrite (stat + word diff) and any uncommitted files.",
    parameters: { type: "object", additionalProperties: false, properties: { slug }, required: ["slug"] },
  },
  work_discard: {
    description: "Throw away uncommitted changes on the work branch.",
    parameters: { type: "object", additionalProperties: false, properties: { slug }, required: ["slug"] },
  },
  work_commit: {
    description: "Run locks; if they pass, commit, build PDFs (posted to #ash-builds), and push ash/<slug> to Origin. If locks fail nothing is committed and the lock drift + diff are returned.",
    parameters: { type: "object", additionalProperties: false, properties: { slug, message: { type: "string" }, volumes: { type: "array", items: volume } }, required: ["slug", "message"] },
  },
  work_pr: {
    description: "Open (or find) the Origin pull request ash/<slug> -> rewrite. Returns url and number.",
    parameters: { type: "object", additionalProperties: false, properties: { slug, title: { type: "string" }, body: { type: "string" } }, required: ["slug", "title"] },
  },
  work_merge: {
    description: "Merge the PR for ash/<slug> into rewrite (squash) after re-running locks on the merge result. ONLY call when Gustavo's latest message explicitly says \"merge\" for this branch; pass confirm=\"merge\".",
    parameters: { type: "object", additionalProperties: false, properties: { slug, confirm: { type: "string", enum: ["merge"] } }, required: ["slug", "confirm"] },
  },
};

function settingsFrom(api) {
  const c = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  return {
    runnerUrl: String(c.runnerUrl || process.env.BOOK_RUNNER_URL || "").trim(),
    buildsChannelId: String(c.buildsChannelId || "").trim(),
    defaultBranch: String(c.defaultBranch || "rewrite").trim(),
  };
}

export default {
  id: "ash-book",
  name: "Ash Book tools",
  description: "Read the trilogy repo, run locks, build and post PDFs via book-runner.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: { runnerUrl: { type: "string" }, buildsChannelId: { type: "string" }, defaultBranch: { type: "string" } },
  },
  register(api) {
    const settings = settingsFrom(api);
    for (const name of [...ASH_TOOL_NAMES, ...ASH_WRITE_TOOL_NAMES]) {
      const spec = TOOLS[name];
      api.registerTool(
        () => ({
          name,
          description: spec.description,
          parameters: spec.parameters,
          async execute(_toolCallId, params) {
            try {
              const details = await executeAshTool(name, params || {}, settings);
              return { content: [{ type: "text", text: JSON.stringify(details) }], details };
            } catch (err) {
              const details = { error: err instanceof Error ? err.message : String(err), status: err?.status || null };
              return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
            }
          },
        }),
        { name },
      );
    }
  },
};
