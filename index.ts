/**
 * Pi + Gondolin Sandbox Extension
 *
 * Overrides pi's built-in read/write/edit/bash tools so they execute inside a
 * Gondolin micro-VM instead of on the host.  The directory you start pi in is
 * mounted read-write at /workspace inside the VM.
 *
 * Usage (load explicitly — not auto-discovered):
 *   cd /your/project
 *   pi -e /path/to/pi-gondolin/index.ts
 *
 * Or install via pi settings.json:
 *   { "extensions": ["/path/to/pi-gondolin"] }
 *
 * Requirements:
 *   - QEMU installed:
 *       macOS:  brew install qemu
 *       Linux:  sudo apt install qemu-system-x86  (x86_64)
 *               sudo apt install qemu-system-arm  (aarch64)
 */

import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

import { RealFSProvider, VM } from "@earendil-works/gondolin";

const GUEST_WORKSPACE = "/workspace";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, path.resolve(localCwd, localPath));
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

// ---------------------------------------------------------------------------
// Operations backed by a live Gondolin VM
// ---------------------------------------------------------------------------

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) {
        throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdoutBuffer;
    },

    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },

    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);
      // Base64 roundtrip to avoid shell quoting issues with arbitrary content
      const b64 = Buffer.from(content).toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
      ].join("\n");
      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) {
        throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
      }
    },

    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function executeGondolinRead(vm: VM, localCwd: string, params: any) {
  const localPath = path.resolve(localCwd, String(params?.path ?? ""));
  const content = (await createGondolinReadOps(vm, localCwd).readFile(localPath)).toString();
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(Number(params?.offset) || 1));
  const limit = Number(params?.limit);
  const selected = lines.slice(
    start - 1,
    Number.isFinite(limit) && limit > 0 ? start - 1 + Math.floor(limit) : undefined,
  );
  return toolResult(selected.join("\n"));
}

async function executeGondolinWrite(vm: VM, localCwd: string, params: any) {
  const localPath = path.resolve(localCwd, String(params?.path ?? ""));
  await createGondolinWriteOps(vm, localCwd).writeFile(localPath, String(params?.content ?? ""));
  return toolResult(`Wrote ${localPath}`);
}

async function executeGondolinEdit(vm: VM, localCwd: string, params: any) {
  const localPath = path.resolve(localCwd, String(params?.path ?? ""));
  const edits = Array.isArray(params?.edits)
    ? params.edits
    : [{ oldText: params?.oldText, newText: params?.newText }];
  const ops = createGondolinEditOps(vm, localCwd);
  let content = (await ops.readFile(localPath)).toString();
  for (const edit of edits) {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw new Error("edit requires oldText and newText");
    }
    const first = content.indexOf(edit.oldText);
    if (first < 0 || first !== content.lastIndexOf(edit.oldText)) {
      throw new Error("edit oldText must match exactly once");
    }
    content = content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length);
  }
  await ops.writeFile(localPath, content);
  return toolResult(`Edited ${localPath}`);
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      // Mirror the abort/timeout plumbing from ssh.ts
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  // Baseline local tools (definitions + renderers reused; execution overridden)
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `Gondolin: starting (mount ${GUEST_WORKSPACE})`),
      );

      const created = await VM.create({
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

      vm = created;

      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `Gondolin: running (${localCwd} → ${GUEST_WORKSPACE})`),
      );
      ctx?.ui.notify(
        `Gondolin VM ready — host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );

      return created;
    })();

    return vmStarting;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so users see errors (missing QEMU, unsupported arch, etc.) early
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  // -------------------------------------------------------------------------
  // Tool overrides — delegate read/write/edit/bash into the VM
  // -------------------------------------------------------------------------

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinRead(activeVm, localCwd, params);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinWrite(activeVm, localCwd, params);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinEdit(activeVm, localCwd, params);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      }).execute(id, params, signal, onUpdate);
    },
  });

  // -------------------------------------------------------------------------
  // User ! commands also run inside the VM
  // -------------------------------------------------------------------------

  pi.on("user_bash", (_event) => {
    if (!vm) return; // VM not up yet, fall back to local
    return { operations: createGondolinBashOps(vm, localCwd) };
  });

  // -------------------------------------------------------------------------
  // System prompt — tell the LLM it is operating on /workspace
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    await ensureVm();
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, host mount: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
