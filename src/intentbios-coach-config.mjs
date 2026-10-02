import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COACH_AGENT_ID,
  COACH_TOOL_NAMES,
  SOPHIA_AGENT_ID,
} from "../plugins/intentbios/client.mjs";

export { COACH_AGENT_ID, COACH_TOOL_NAMES, SOPHIA_AGENT_ID };

const PLUGIN_ID = "intentbios";
const COACH_NAME = "Intentbios Coach";

const workspaceTemplateDir = fileURLToPath(
  new URL("../plugins/intentbios/workspace/", import.meta.url),
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  const next = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (!next.includes(value)) next.push(value);
  }
  return next;
}

function samePath(left, right) {
  if (left === right) return true;
  try {
    return path.resolve(left) === path.resolve(right);
  } catch {
    return false;
  }
}

function appendPath(paths, pluginPath) {
  const next = Array.isArray(paths) ? paths.slice() : [];
  if (!next.some((entry) => samePath(entry, pluginPath))) {
    next.push(pluginPath);
  }
  return next;
}

function unionAllow(existing, required) {
  return uniqueStrings([...(Array.isArray(existing) ? existing : []), ...required]);
}

function withoutNames(existing, names) {
  if (!Array.isArray(existing)) return existing;
  return existing.filter((name) => !names.includes(name));
}

/**
 * Copy the bundled coach workspace into workspaceDir.
 * Overwrites the template files so a deploy can refresh the coach prompt.
 * @param {string} workspaceDir
 */
export function writeCoachWorkspace(workspaceDir) {
  if (!workspaceDir || typeof workspaceDir !== "string") {
    throw new Error("writeCoachWorkspace requires workspaceDir");
  }
  if (!fs.existsSync(workspaceTemplateDir)) {
    throw new Error(`coach workspace templates missing at ${workspaceTemplateDir}`);
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const name of fs.readdirSync(workspaceTemplateDir)) {
    const from = path.join(workspaceTemplateDir, name);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(workspaceDir, name));
  }
  return workspaceDir;
}

function ensureCoachAgent(agents, workspaceDir) {
  const next = isPlainObject(agents) ? { ...agents } : {};
  const entries = isPlainObject(next.entries) ? { ...next.entries } : null;
  const seeded = entries ? { ...entries } : { main: { default: true } };
  if (!entries && typeof next.defaults?.workspace === "string") {
    seeded.main = { ...seeded.main, workspace: next.defaults.workspace };
  }

  const sophia = seeded[SOPHIA_AGENT_ID];
  const current = isPlainObject(seeded[COACH_AGENT_ID])
    ? { ...seeded[COACH_AGENT_ID] }
    : {};
  const tools = isPlainObject(current.tools) ? { ...current.tools } : {};
  const allow = unionAllow(tools.allow, unionAllow(tools.alsoAllow, COACH_TOOL_NAMES));
  delete tools.alsoAllow;
  tools.allow = allow;
  if (Array.isArray(tools.deny)) {
    const deny = withoutNames(tools.deny, COACH_TOOL_NAMES);
    if (deny.length > 0) tools.deny = deny;
    else delete tools.deny;
  }
  current.tools = tools;
  if (!current.name) current.name = COACH_NAME;
  current.workspace = workspaceDir;
  seeded[COACH_AGENT_ID] = current;

  if (sophia !== undefined) {
    seeded[SOPHIA_AGENT_ID] = sophia;
  }

  const entryList = Object.entries(seeded);
  const hasDefault = entryList.some(([, entry]) => entry?.default === true);
  if (entryList.length > 1 && !hasDefault && next.ownership !== "explicit") {
    next.ownership = "explicit";
  }
  next.entries = seeded;
  return next;
}

function ensurePlugin(plugins, { apiUrl, pluginPath, defaultUserId }) {
  const next = isPlainObject(plugins) ? { ...plugins } : {};
  next.enabled = true;
  const load = isPlainObject(next.load) ? { ...next.load } : {};
  load.paths = appendPath(load.paths, pluginPath);
  next.load = load;

  if (Array.isArray(next.allow)) {
    next.allow = unionAllow(next.allow, [PLUGIN_ID]);
  }
  if (Array.isArray(next.deny)) {
    next.deny = withoutNames(next.deny, [PLUGIN_ID]);
  }

  const entries = isPlainObject(next.entries) ? { ...next.entries } : {};
  const current = isPlainObject(entries[PLUGIN_ID]) ? { ...entries[PLUGIN_ID] } : {};
  const config = isPlainObject(current.config) ? { ...current.config } : {};
  config.apiUrl = apiUrl;
  if (typeof defaultUserId === "string" && defaultUserId.trim()) {
    config.defaultUserId = defaultUserId.trim();
  }
  current.enabled = true;
  current.config = config;
  entries[PLUGIN_ID] = current;
  next.entries = entries;
  return next;
}

function ensureChatCompletions(gateway) {
  const next = isPlainObject(gateway) ? { ...gateway } : {};
  const http = isPlainObject(next.http) ? { ...next.http } : {};
  const endpoints = isPlainObject(http.endpoints) ? { ...http.endpoints } : {};
  const chatCompletions = isPlainObject(endpoints.chatCompletions)
    ? { ...endpoints.chatCompletions }
    : {};
  chatCompletions.enabled = true;
  endpoints.chatCompletions = chatCompletions;
  http.endpoints = endpoints;
  next.http = http;
  return next;
}

function ensureGlobalToolAllow(tools) {
  if (!isPlainObject(tools)) return tools;
  const next = { ...tools };
  if (Array.isArray(next.allow)) {
    next.allow = unionAllow(next.allow, COACH_TOOL_NAMES);
  }
  if (Array.isArray(next.deny)) {
    next.deny = withoutNames(next.deny, COACH_TOOL_NAMES);
  }
  return next;
}

/**
 * Enable the intentbios-coach agent and plugin without changing intentbios-sophia.
 * Returns the original config when apiUrl is missing so boot can skip a write.
 * @param {object} config
 * @param {{ apiUrl?: string, pluginPath: string, workspaceDir: string, defaultUserId?: string }} options
 */
export function mergeIntentbiosCoachConfig(config, options = {}) {
  if (!isPlainObject(config)) {
    throw new Error("mergeIntentbiosCoachConfig requires an openclaw.json object");
  }
  const apiUrl = typeof options.apiUrl === "string" ? options.apiUrl.trim() : "";
  if (!apiUrl) return config;
  if (!options.pluginPath) {
    throw new Error("mergeIntentbiosCoachConfig requires pluginPath");
  }
  if (!options.workspaceDir) {
    throw new Error("mergeIntentbiosCoachConfig requires workspaceDir");
  }

  const sophiaBefore = config.agents?.entries?.[SOPHIA_AGENT_ID];
  const merged = {
    ...config,
    gateway: ensureChatCompletions(config.gateway),
    plugins: ensurePlugin(config.plugins, {
      apiUrl,
      pluginPath: options.pluginPath,
      defaultUserId: options.defaultUserId,
    }),
    agents: ensureCoachAgent(config.agents, options.workspaceDir),
  };
  if (config.tools !== undefined) {
    merged.tools = ensureGlobalToolAllow(config.tools);
  }
  const sophiaAfter = merged.agents?.entries?.[SOPHIA_AGENT_ID];
  if (sophiaBefore !== sophiaAfter) {
    throw new Error("refusing to modify intentbios-sophia");
  }
  return merged;
}

export function configDeepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (!left || typeof left !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => configDeepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => configDeepEqual(left[key], right[key]));
}
