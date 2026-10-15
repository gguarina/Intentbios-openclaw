/**
 * OpenClaw plugin: ash-book. Read-only trilogy tools for ash-editor, ash-coldreader and ash-continuity.
 * Writes (edits, commits, pushes) are Phase 3 and deliberately absent.
 */
import { ASH_TOOL_NAMES, executeAshTool } from "./client.mjs";

const branch = { type: "string", description: "Git branch (default: rewrite, the canonical branch)." };
const volume = { type: "integer", minimum: 1, maximum: 3, description: "1 = The Ash, 2 = The Bands, 3 = The Pattern." };

const TOOLS = {
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
    for (const name of ASH_TOOL_NAMES) {
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
