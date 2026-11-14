#!/usr/bin/env node
// Tests de l'adaptateur claude-code (Node, sans dépendance).
//
//   node Adapters/claude-code.pupitre-adapter/test/run.js            # vérifie
//   node Adapters/claude-code.pupitre-adapter/test/run.js --update   # régénère fixtures/*/expected.json
//
// decoder.js est évalué dans un contexte vierge (vm) : pas de require, pas de module, pas de globals Node,
// comme dans JavaScriptCore.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADAPTER = path.resolve(__dirname, "..");
const FIXTURES = path.join(ADAPTER, "fixtures");
const UPDATE = process.argv.includes("--update");

// ---------------------------------------------------------------------------
// Chargement du décodeur en contexte isolé

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ADAPTER, "decoder.js"), "utf8"), sandbox, { filename: "decoder.js" });
for (const fn of ["decodeLine", "decodeFile", "decodeAgentMeta", "discover", "mapHookEvent"]) {
  if (typeof sandbox[fn] !== "function") {
    console.error(`decoder.js ne définit pas la fonction globale ${fn}`);
    process.exit(1);
  }
}
// Les valeurs créées dans le contexte vm ont d'autres prototypes : on repasse par JSON
// (c'est aussi ce que fait l'app, qui ne reçoit que du JSON).
const call = (fn, ...args) => JSON.parse(JSON.stringify(sandbox[fn](...args) ?? null));

// ---------------------------------------------------------------------------
// Petit harnais

let passed = 0;
let failed = 0;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`ÉCHEC ${name}${detail ? "\n  " + detail : ""}`);
  }
}

function firstDiff(actual, expected) {
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (!deepEqual(actual[i], expected[i])) {
      return `événement #${i}\n  obtenu  : ${JSON.stringify(actual[i])}\n  attendu : ${JSON.stringify(expected[i])}`;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fixtures : fixtures/<nom>/**  → expected.json { "<chemin relatif>": sortie }

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

function decodeFixtureFile(dir, rel) {
  const text = fs.readFileSync(path.join(dir, rel), "utf8");
  if (rel.endsWith(".meta.json")) return call("decodeAgentMeta", text);
  const m = /(?:^|\/)subagents\/(?:.*\/)?agent-([^/]+)\.jsonl$/.exec(rel);
  const ctx = m ? { role: "agent", agentId: m[1] } : { role: "main" };
  return call("decodeFile", text, ctx);
}

const fixtureNames = fs.existsSync(FIXTURES)
  ? fs.readdirSync(FIXTURES).filter((n) => fs.statSync(path.join(FIXTURES, n)).isDirectory()).sort()
  : [];
check("au moins une fixture", fixtureNames.length > 0);

for (const name of fixtureNames) {
  const dir = path.join(FIXTURES, name);
  const files = walk(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".meta.json"));
  const actual = {};
  for (const rel of files) actual[rel] = decodeFixtureFile(dir, rel);
  const expectedPath = path.join(dir, "expected.json");

  if (UPDATE) {
    fs.writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + "\n");
    console.log(`mis à jour : fixtures/${name}/expected.json (${files.length} fichiers)`);
    continue;
  }
  if (!fs.existsSync(expectedPath)) {
    check(`fixture ${name}`, false, "expected.json manquant (lancer avec --update)");
    continue;
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  check(`fixture ${name} : mêmes fichiers`, deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort()),
    `obtenu ${JSON.stringify(Object.keys(actual))}, attendu ${JSON.stringify(Object.keys(expected))}`);
  for (const rel of files) {
    const a = actual[rel], e = expected[rel];
    const ok = deepEqual(a, e);
    check(`fixture ${name}/${rel}`, ok, ok ? "" : (Array.isArray(a) && Array.isArray(e) ? firstDiff(a, e) : JSON.stringify(a)));
  }

  // Cohérence : discover() sur l'arborescence subagents/ de la fixture.
  const subFiles = files.filter((f) => /\/subagents\//.test(f)).map((f) => f.replace(/^.*?\/subagents\//, ""));
  if (subFiles.length) {
    const found = call("discover", subFiles);
    const jsonl = subFiles.filter((f) => f.endsWith(".jsonl"));
    check(`fixture ${name} : discover trouve chaque transcript`, found.length === jsonl.length,
      JSON.stringify(found));
    check(`fixture ${name} : discover associe les .meta.json`,
      found.every((it) => it.meta === undefined || subFiles.includes(it.meta)) &&
      found.filter((it) => it.meta).length === subFiles.filter((f) => f.endsWith(".meta.json")).length,
      JSON.stringify(found));
  }
}

if (UPDATE) {
  console.log("expected.json régénérés ; relancer sans --update pour vérifier.");
}

// ---------------------------------------------------------------------------
// Tests unitaires sur des lignes ciblées (formes réelles, contenus raccourcis)

const MAIN = { role: "main" };
const base = {
  parentUuid: "p-0", isSidechain: false, uuid: "u-1", timestamp: "2026-11-14T10:00:00.000Z",
  userType: "external", entrypoint: "cli", cwd: "/Users/user/Projet/project",
  sessionId: "s-1", version: "2.1.325", gitBranch: "main",
};
const userLine = (content, extra = {}) => JSON.stringify({ ...base, type: "user", message: { role: "user", content }, ...extra });
const decode = (line, ctx = MAIN) => call("decodeLine", line, ctx);
const kinds = (evs) => evs.map((e) => e.kind);
const withoutMeta = (evs) => evs.filter((e) => e.kind !== "session.meta");

function unit(name, fn) {
  try {
    fn();
  } catch (e) {
    check(name, false, String(e && e.stack || e));
  }
}

unit("prompt chaîne", () => {
  const evs = decode(userLine("tu peux lancer les tests ?"));
  check("prompt chaîne : session.meta puis user.prompt", deepEqual(kinds(evs), ["session.meta", "user.prompt"]), JSON.stringify(evs));
  const p = evs[1];
  check("prompt chaîne : champs", p.text === "tu peux lancer les tests ?" && p.imageCount === 0 && p.uuid === "u-1" &&
    p.timestamp === base.timestamp, JSON.stringify(p));
  check("session.meta : champs", deepEqual(evs[0], { kind: "session.meta", uuid: "u-1", timestamp: base.timestamp,
    sessionId: "s-1", cwd: base.cwd, gitBranch: "main", cliVersion: "2.1.325" }), JSON.stringify(evs[0]));
});

unit("prompt tableau avec image", () => {
  const evs = withoutMeta(decode(userLine([
    { type: "text", text: "regarde ça : [Image #1] [Image #2]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "" } },
  ], { imagePasteIds: [1, 2] })));
  check("prompt image", evs.length === 1 && evs[0].kind === "user.prompt" && evs[0].imageCount === 2 &&
    evs[0].text === "regarde ça : [Image #1] [Image #2]", JSON.stringify(evs));
});

unit("image seule", () => {
  const evs = withoutMeta(decode(userLine([{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }])));
  check("image seule = prompt", evs.length === 1 && evs[0].kind === "user.prompt" && evs[0].imageCount === 1 && evs[0].text === "",
    JSON.stringify(evs));
});

unit("tool_result seul", () => {
  const evs = withoutMeta(decode(userLine([
    { tool_use_id: "toolu_1", type: "tool_result", content: "ok\n" },
    { tool_use_id: "toolu_2", type: "tool_result", content: [{ type: "text", text: "erreur" }], is_error: true },
  ])));
  check("tool_result seul : pas de prompt", deepEqual(kinds(evs), ["tool.result", "tool.result"]), JSON.stringify(evs));
  check("tool_result : champs", evs[0].toolUseId === "toolu_1" && evs[0].isError === false && evs[0].text === "ok\n" &&
    evs[1].isError === true && evs[1].text === "erreur", JSON.stringify(evs));
});

unit("tool_result tronqué", () => {
  const long = "x".repeat(10000);
  const evs = withoutMeta(decode(userLine([{ tool_use_id: "t", type: "tool_result", content: long }])));
  check("tool_result tronqué à 4000", evs[0].text.length === 4000, String(evs[0].text.length));
});

unit("tool_result accusé d'agent asynchrone", () => {
  const evs = withoutMeta(decode(userLine(
    [{ tool_use_id: "toolu_a", type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] }],
    { toolUseResult: { isAsync: true, status: "async_launched", agentId: "a0123456789abcdef" } })));
  check("tool.result async + agentId", evs.length === 1 && evs[0].async === true && evs[0].agentId === "a0123456789abcdef",
    JSON.stringify(evs));
});

unit("isMeta", () => {
  const evs = decode(userLine("<local-command-caveat>Caveat…</local-command-caveat>", { isMeta: true }));
  check("isMeta : aucun événement de contenu", withoutMeta(evs).length === 0, JSON.stringify(evs));
  const evs2 = decode(userLine([{ type: "text", text: "[Image: source: /tmp/x.png]" }], { isMeta: true }));
  check("isMeta tableau : rien", withoutMeta(evs2).length === 0, JSON.stringify(evs2));
});

unit("<command-name>", () => {
  const evs = withoutMeta(decode(userLine(
    "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>")));
  check("commande : user.command", evs.length === 1 && evs[0].kind === "user.command" && evs[0].name === "/effort" &&
    evs[0].args === "high", JSON.stringify(evs));
  const clear = withoutMeta(decode(userLine(
    "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>")));
  check("commande /clear sans args", clear.length === 1 && clear[0].name === "/clear" && !("args" in clear[0]), JSON.stringify(clear));
  const sys = withoutMeta(decode(JSON.stringify({ ...base, type: "system", subtype: "local_command", level: "info", isMeta: false,
    content: "<command-name>/skills</command-name>\n            <command-message>skills</command-message>\n            <command-args></command-args>" })));
  check("commande en ligne system", sys.length === 1 && sys[0].kind === "user.command" && sys[0].name === "/skills", JSON.stringify(sys));
  const bare = withoutMeta(decode(userLine("/compact")));
  check("« /compact » tapé seul (doublon) : rien", bare.length === 0, JSON.stringify(bare));
  const pathPrompt = withoutMeta(decode(userLine("/Users/user/Downloads/doc.pdf")));
  check("chemin absolu = vrai prompt", pathPrompt.length === 1 && pathPrompt[0].kind === "user.prompt", JSON.stringify(pathPrompt));
});

unit("<bash-input>", () => {
  const evs = withoutMeta(decode(userLine("<bash-input> git status</bash-input>")));
  check("mode ! : user.command « ! »", evs.length === 1 && evs[0].kind === "user.command" && evs[0].name === "!" &&
    evs[0].args === "git status", JSON.stringify(evs));
  const out = withoutMeta(decode(userLine("<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>")));
  check("sortie de ! : rien", out.length === 0, JSON.stringify(out));
});

unit("<local-command-stdout>", () => {
  const evs = withoutMeta(decode(userLine("<local-command-stdout>Set effort level to high</local-command-stdout>")));
  check("sortie de commande seule : rien", evs.length === 0, JSON.stringify(evs));
  const sys = withoutMeta(decode(JSON.stringify({ ...base, type: "system", subtype: "local_command",
    content: "<local-command-stdout>No changes</local-command-stdout>", commandRun: { command: "skills", args: "" } })));
  check("sortie de commande (system) : rien", sys.length === 0, JSON.stringify(sys));
});

unit("<system-reminder>", () => {
  const evs = withoutMeta(decode(userLine("<system-reminder>\nRappel interne\n</system-reminder>")));
  check("system-reminder : rien", evs.length === 0, JSON.stringify(evs));
  const arr = withoutMeta(decode(userLine([{ type: "text", text: "<system-reminder>x</system-reminder>" }])));
  check("system-reminder (tableau) : rien", arr.length === 0, JSON.stringify(arr));
});

unit("interruption", () => {
  const evs = withoutMeta(decode(userLine([{ type: "text", text: "[Request interrupted by user]" }], { interruptedMessageId: "msg_1" })));
  check("interruption : user.interrupt", evs.length === 1 && evs[0].kind === "user.interrupt" &&
    evs[0].text === "[Request interrupted by user]", JSON.stringify(evs));
  const tool = withoutMeta(decode(userLine([
    { tool_use_id: "t1", type: "tool_result", content: "The user doesn't want to proceed with this tool use.", is_error: true },
    { type: "text", text: "[Request interrupted by user for tool use]" },
  ])));
  check("interruption pendant un outil", deepEqual(kinds(tool), ["tool.result", "user.interrupt"]), JSON.stringify(tool));
});

unit("compact summary", () => {
  const evs = withoutMeta(decode(userLine("This session is being continued from a previous conversation…",
    { isCompactSummary: true, isVisibleInTranscriptOnly: true })));
  check("résumé de compaction : rien", evs.length === 0, JSON.stringify(evs));
});

unit("isSidechain", () => {
  const line = userLine("prompt de sous-agent", { isSidechain: true });
  check("isSidechain dans main : ignorée", decode(line, MAIN).length === 0, JSON.stringify(decode(line, MAIN)));
  const agent = decode(line, { role: "agent", agentId: "a1" });
  check("isSidechain dans agent : décodée", agent.length === 1 && agent[0].kind === "user.prompt", JSON.stringify(agent));
});

unit("assistant", () => {
  const msg = (content, usage) => JSON.stringify({ ...base, type: "assistant", message: {
    model: "claude-opus-5-5", id: "msg_1", type: "message", role: "assistant", content,
    usage: usage || { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } });
  const evs = withoutMeta(decode(msg([
    { type: "thinking", thinking: "", signature: "x" },
    { type: "thinking", thinking: "Je réfléchis", signature: "x" },
    { type: "text", text: "Voilà." },
  ])));
  check("assistant : thinking vide ignoré, texte, usage", deepEqual(kinds(evs), ["assistant.thinking", "assistant.text", "assistant.usage"]),
    JSON.stringify(evs));
  check("assistant.text : champs", evs[1].messageId === "msg_1" && evs[1].text === "Voilà." && evs[1].model === "claude-opus-5-5");
  check("assistant.usage : champs", deepEqual(evs[2], { kind: "assistant.usage", uuid: "u-1", timestamp: base.timestamp,
    messageId: "msg_1", model: "claude-opus-5-5", inputTokens: 3, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 5 }),
    JSON.stringify(evs[2]));

  const tools = withoutMeta(decode(msg([
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.swift" } },
    { type: "tool_use", id: "t2", name: "Bash", input: { command: "swift build 2>&1 | tail -5\necho fini", description: "Build" } },
    { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "func decode", path: "." } },
    { type: "tool_use", id: "t4", name: "WebFetch", input: { url: "https://example.com/doc", prompt: "?" } },
    { type: "tool_use", id: "t5", name: "WebSearch", input: { query: "swift 6 sendable" } },
    { type: "tool_use", id: "t6", name: "Edit", input: { file_path: "/a/c.swift", old_string: "a\nb", new_string: "a\nb\nc\n" } },
    { type: "tool_use", id: "t7", name: "Write", input: { file_path: "/a/d.md", content: "1\n2\n3" } },
    { type: "tool_use", id: "t8", name: "MultiEdit", input: { file_path: "/a/e.js", edits: [
      { old_string: "x", new_string: "y\nz" }, { old_string: "p\nq", new_string: "" }] } },
    { type: "tool_use", id: "t9", name: "mcp__serveur__outil", input: { foo: 1 } },
    { type: "tool_use", id: "t10", name: "Bash", input: { command: "x".repeat(200) } },
  ]))).filter((e) => e.kind === "tool.call");
  const byId = Object.fromEntries(tools.map((e) => [e.toolUseId, e]));
  check("tool.call : 10 appels", tools.length === 10, JSON.stringify(tools));
  check("target Read", byId.t1.target === "/a/b.swift" && byId.t1.name === "Read" && byId.t1.messageId === "msg_1");
  check("target Bash (1re ligne)", byId.t2.target === "swift build 2>&1 | tail -5 …", byId.t2.target);
  check("target Bash tronquée à 80", byId.t10.target.length === 80, String(byId.t10.target.length));
  check("target Grep", byId.t3.target === "func decode");
  check("target WebFetch", byId.t4.target === "https://example.com/doc");
  check("target WebSearch", byId.t5.target === "swift 6 sendable");
  check("target inconnu = null", byId.t9.target === null && !("fileChange" in byId.t9), JSON.stringify(byId.t9));
  check("fileChange Edit", deepEqual(byId.t6.fileChange, { path: "/a/c.swift", added: 3, removed: 2 }), JSON.stringify(byId.t6.fileChange));
  check("fileChange Write", deepEqual(byId.t7.fileChange, { path: "/a/d.md", added: 3 }), JSON.stringify(byId.t7.fileChange));
  check("fileChange MultiEdit", deepEqual(byId.t8.fileChange, { path: "/a/e.js", added: 2, removed: 3 }), JSON.stringify(byId.t8.fileChange));

  const agents = withoutMeta(decode(msg([
    { type: "tool_use", id: "ta", name: "Agent", input: { description: "Revue", subagent_type: "relecteur", prompt: "Relis", run_in_background: "true" } },
    { type: "tool_use", id: "tb", name: "Task", input: { description: "Ancien", prompt: "Fais" } },
  ]))).filter((e) => e.kind !== "assistant.usage");
  check("Agent/Task → agent.start (pas de tool.call)", deepEqual(kinds(agents), ["agent.start", "agent.start"]), JSON.stringify(agents));
  check("agent.start champs", agents[0].toolUseId === "ta" && agents[0].agentType === "relecteur" && agents[0].description === "Revue" &&
    agents[0].prompt === "Relis" && agents[0].background === true && agents[1].background === false &&
    agents[1].agentType === "general-purpose", JSON.stringify(agents));
});

unit("fin d'agent en arrière-plan", () => {
  const notif = (status, summary, extra = "") => "<task-notification>\n<task-id>a0123456789abcdef</task-id>\n" +
    "<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/a.output</output-file>\n<status>" + status + "</status>\n" +
    "<summary>" + summary + "</summary>\n" + extra + "</task-notification>";
  const att = (prompt) => JSON.stringify({ ...base, type: "attachment", attachment: { type: "queued_command", prompt,
    commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" } } });

  const done = decode(att(notif("completed", 'Agent "Revue" finished', "<result>Tout est conforme.</result>\n")));
  check("queued_command → agent.end done", done.length === 1 && deepEqual(done[0], { kind: "agent.end", uuid: "u-1",
    timestamp: base.timestamp, status: "done", toolUseId: "toolu_x", agentId: "a0123456789abcdef", resultText: "Tout est conforme." }),
    JSON.stringify(done));
  const killed = decode(att(notif("killed", 'Agent "Revue" was stopped by Claude')));
  check("killed → failed", killed.length === 1 && killed[0].status === "failed", JSON.stringify(killed));
  const waiting = decode(att(notif("completed", 'Agent "Revue" is waiting on its own background work')));
  check("agent en attente de ses propres tâches : pas de fin", waiting.length === 0, JSON.stringify(waiting));
  const bash = decode(att("<task-notification>\n<task-id>bg533hbqu</task-id>\n<status>completed</status>\n" +
    "<summary>Background command \"x\" completed</summary>\n</task-notification>"));
  check("commande Bash en arrière-plan : pas d'agent.end", bash.length === 0, JSON.stringify(bash));

  const userNotif = withoutMeta(decode(userLine(notif("failed", 'Agent "Revue" failed'),
    { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system" })));
  check("ligne user <task-notification> → agent.end, pas de prompt", userNotif.length === 1 && userNotif[0].kind === "agent.end" &&
    userNotif[0].status === "failed", JSON.stringify(userNotif));

  const handback = withoutMeta(decode(userLine("Another Claude session sent a message:\n<agent-message from=\"a0123456789abcdef\">\n[Subagent hand-back] …",
    { isMeta: true, origin: { kind: "peer", from: "a0123456789abcdef", handback: true, handbackReportText: "Rapport final." } })));
  check("hand-back (isMeta, origin peer) → agent.end", handback.length === 1 && handback[0].kind === "agent.end" &&
    handback[0].agentId === "a0123456789abcdef" && handback[0].resultText === "Rapport final." && handback[0].status === "done",
    JSON.stringify(handback));
  const peer = withoutMeta(decode(userLine("Another Claude session sent a message:\n<cross-session-message>…",
    { isMeta: true, origin: { kind: "peer", from: "s-2" } })));
  check("message d'une autre session (sans hand-back) : rien", peer.length === 0, JSON.stringify(peer));
});

unit("prompt mis en file pendant un tour", () => {
  const evs = decode(JSON.stringify({ ...base, type: "attachment", attachment: { type: "queued_command",
    prompt: "pardon, le fichier b", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true } }));
  check("queued_command humain → user.prompt queued", evs.length === 1 && evs[0].kind === "user.prompt" &&
    evs[0].text === "pardon, le fichier b" && evs[0].queued === true && evs[0].imageCount === 0, JSON.stringify(evs));
});

unit("entrées invalides", () => {
  check("JSON invalide → []", deepEqual(call("decodeLine", "{pas du json", MAIN), []));
  check("ligne vide → []", deepEqual(call("decodeLine", "", MAIN), []));
  check("non-chaîne → []", deepEqual(call("decodeLine", null, MAIN), []) && deepEqual(call("decodeLine", 42, MAIN), []));
  check("tableau JSON → []", deepEqual(call("decodeLine", "[1,2]", MAIN), []));
  check("type inconnu → []", deepEqual(call("decodeLine", JSON.stringify({ ...base, type: "nouveau-type", foo: 1 }), MAIN), []));
  for (const t of ["queue-operation", "last-prompt", "mode", "permission-mode", "file-history-snapshot", "cost-state"]) {
    check(`type ${t} → []`, deepEqual(call("decodeLine", JSON.stringify({ type: t, sessionId: "s-1" }), MAIN), []));
  }
  check("user sans message → session.meta seul", deepEqual(kinds(decode(JSON.stringify({ ...base, type: "user" }))), ["session.meta"]));
  check("assistant content bizarre → pas d'exception",
    Array.isArray(call("decodeLine", JSON.stringify({ ...base, type: "assistant", message: { content: [null, 3, { type: "tool_use" }] } }), MAIN)));
  check("ctx absent → traité comme main", Array.isArray(call("decodeLine", userLine("x"))));
  check("decodeFile non-chaîne → []", deepEqual(call("decodeFile", undefined, MAIN), []));
  check("decodeFile lignes mêlées", deepEqual(kinds(withoutMeta(call("decodeFile", "garbage\n" + userLine("a") + "\n\n{]\n", MAIN))), ["user.prompt"]));
  check("decodeAgentMeta invalide → null", call("decodeAgentMeta", "{") === null && call("decodeAgentMeta", "[]") === null);
  check("mapHookEvent invalide → []", deepEqual(call("mapHookEvent", null), []) && deepEqual(call("mapHookEvent", "{"), []) &&
    deepEqual(call("mapHookEvent", [1]), []) && deepEqual(call("mapHookEvent", { hook_event_name: 3 }), []));
});

unit("mapHookEvent", () => {
  // Formes de la doc officielle des hooks (chemins fictifs).
  const common = { session_id: "11111111-2222-4333-8444-555555555555", cwd: "/Users/user/Projet/project",
    transcript_path: "/Users/user/.claude/projects/-Users-user-Projet-project/11111111-2222-4333-8444-555555555555.jsonl",
    permission_mode: "default" };
  const hook = (name, extra = {}) => call("mapHookEvent", { ...common, hook_event_name: name, ...extra });

  check("SessionStart → hook.session", deepEqual(hook("SessionStart", { source: "clear", model: "m" }), [{ kind: "hook.session",
    sessionId: common.session_id, transcriptPath: common.transcript_path, source: "clear" }]), JSON.stringify(hook("SessionStart")));
  check("SessionStart sans session_id → []", deepEqual(call("mapHookEvent", { hook_event_name: "SessionStart", source: "startup" }), []));
  check("SessionStart reçu en texte JSON", deepEqual(call("mapHookEvent", JSON.stringify({ ...common, hook_event_name: "SessionStart" })),
    [{ kind: "hook.session", sessionId: common.session_id, transcriptPath: common.transcript_path }]));
  check("UserPromptSubmit → hook.busy (le prompt n'est pas recopié)",
    deepEqual(hook("UserPromptSubmit", { prompt: "secret" }), [{ kind: "hook.busy" }]));
  check("Stop → hook.idle + message", deepEqual(hook("Stop", { stop_hook_active: false, last_assistant_message: "  OK  " }),
    [{ kind: "hook.idle", message: "OK" }]));
  check("Stop sans message", deepEqual(hook("Stop"), [{ kind: "hook.idle" }]));
  const long = hook("Stop", { last_assistant_message: "y".repeat(5000) });
  check("Stop : message tronqué à 1000", long[0].message.length === 1000, String(long[0].message.length));
  check("SubagentStop → hook.agentStop", deepEqual(hook("SubagentStop", { agent_id: "def456", agent_type: "Explore",
    agent_transcript_path: "/x/subagents/agent-def456.jsonl", last_assistant_message: "fini" }),
    [{ kind: "hook.agentStop", agentId: "def456", transcriptPath: "/x/subagents/agent-def456.jsonl" }]));
  check("Notification permission → hook.attention", deepEqual(hook("Notification", { message: "Claude needs your permission to use Bash",
    title: "Permission needed", notification_type: "permission_prompt" }),
    [{ kind: "hook.attention", message: "Claude needs your permission to use Bash" }]));
  check("Notification elicitation → hook.attention", hook("Notification", { message: "?", notification_type: "elicitation_dialog" }).length === 1);
  check("Notification idle_prompt → []", deepEqual(hook("Notification", { message: "Claude is waiting for your input",
    notification_type: "idle_prompt" }), []));
  check("Notification auth_success → []", deepEqual(hook("Notification", { message: "ok", notification_type: "auth_success" }), []));
  check("Notification sans type : permission → attention", hook("Notification", { message: "Claude needs your permission" }).length === 1);
  check("Notification sans type : inactivité → []", deepEqual(hook("Notification", { message: "Claude is waiting for your input" }), []));
  check("Événement non branché → []", deepEqual(hook("PreToolUse", { tool_name: "Bash" }), []) && deepEqual(hook("SessionEnd"), []));
});

unit("titre de session (ai-title)", () => {
  const line = JSON.stringify({ type: "ai-title", aiTitle: "Localisation de l'application", sessionId: "s-1" });
  const evs = decode(line);
  check("ai-title → session.meta avec title", deepEqual(evs, [{ kind: "session.meta", uuid: null, sessionId: "s-1",
    title: "Localisation de l'application" }]), JSON.stringify(evs));
  check("ai-title dans un transcript d'agent : rien", deepEqual(decode(line, { role: "agent", agentId: "a1" }), []));
  check("ai-title vide : rien", deepEqual(decode(JSON.stringify({ type: "ai-title", aiTitle: "  ", sessionId: "s-1" })), []));
  check("ai-title sans sessionId : rien", deepEqual(decode(JSON.stringify({ type: "ai-title", aiTitle: "x" })), []));
  check("ai-title non chaîne : rien", deepEqual(decode(JSON.stringify({ type: "ai-title", aiTitle: 3, sessionId: "s-1" })), []));
  const long = decode(JSON.stringify({ type: "ai-title", aiTitle: "t".repeat(500), sessionId: "s-1" }));
  check("ai-title tronqué à 200", long.length === 1 && long[0].title.length === 200, JSON.stringify(long));
});

unit("decodeAgentMeta", () => {
  const m = call("decodeAgentMeta", JSON.stringify({ agentType: "implementeur", description: "T1", toolUseId: "toolu_1",
    requestShape: "background", finished: true, model: "sonnet", spawnDepth: 1 }));
  check("meta complète", deepEqual(m, { agentType: "implementeur", description: "T1", toolUseId: "toolu_1",
    background: true, finished: true, model: "sonnet" }), JSON.stringify(m));
  const wf = call("decodeAgentMeta", JSON.stringify({ agentType: "workflow-subagent", description: "T6", requestShape: "foreground" }));
  check("meta de workflow sans toolUseId", wf.toolUseId === null && wf.background === false, JSON.stringify(wf));
});

unit("discover", () => {
  const found = call("discover", ["agent-abc.jsonl", "agent-abc.meta.json", "agent-def.jsonl", "notes.txt",
    "workflows/run1/agent-ghi.jsonl", "workflows/run1/agent-ghi.meta.json", "workflows/run1/journal.jsonl"]);
  check("discover", deepEqual(found, [
    { agentId: "abc", transcript: "agent-abc.jsonl", meta: "agent-abc.meta.json" },
    { agentId: "def", transcript: "agent-def.jsonl" },
    { agentId: "ghi", transcript: "workflows/run1/agent-ghi.jsonl", meta: "workflows/run1/agent-ghi.meta.json" },
  ]), JSON.stringify(found));
  check("discover invalide → []", deepEqual(call("discover", null), []) && deepEqual(call("discover", [null, 3]), []));
});

// ---------------------------------------------------------------------------

console.log(`${passed} vérifications réussies, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
