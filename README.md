# pi-gondolin

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that runs all tool calls (bash, read, write, edit) inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM sandbox instead of directly on the host.

Your working directory is mounted read-write at `/workspace` inside the VM. The LLM sees `/workspace` as its working directory. Commands that could harm your host system run in an isolated environment — network access, filesystem, and processes are all contained.

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) (`npx @mariozechner/pi-coding-agent`)
- QEMU:
  - macOS: `brew install qemu`
  - Linux (x86_64): `sudo apt install qemu-system-x86`
  - Linux (aarch64): `sudo apt install qemu-system-arm`
- Node.js 18+

## Install

```sh
git clone https://github.com/pasky/pi-gondolin
cd pi-gondolin
npm install
```

## Usage

Load the extension explicitly when starting pi:

```sh
cd /your/project
pi -e /path/to/pi-gondolin/index.ts
```

Or register it permanently in `~/.pi/agent/settings.json` (project-specific or global):

```json
{
  "extensions": ["/path/to/pi-gondolin"]
}
```

On first run, gondolin downloads a guest image (~200 MB) into `~/.cache/gondolin/`.

## What it does

- **Overrides `bash`** — commands run via `/bin/bash -lc` inside the VM
- **Overrides `read`** — files are read from the VM's `/workspace` tree
- **Overrides `write` / `edit`** — writes go into the VM, synced to the host mount
- **Routes `!` commands** — user shell commands (`!ls`, `!!git diff`) also run in the VM
- **Patches the system prompt** — tells the LLM its cwd is `/workspace`
- **Lazy + eager start** — VM starts on `session_start`; any tool call also triggers it if needed
- **Clean shutdown** — VM is closed when the pi session ends

## How it works

Gondolin boots a lightweight QEMU micro-VM in under a second. The `RealFSProvider` mounts your local working directory into the VM via a FUSE-backed virtual filesystem, so reads and writes are bidirectional. All `exec` calls go through gondolin's `vm.exec()` API with streamed output piped back to pi's tool result renderer.

The wiring follows the pattern from the [gondolin wiring gist](https://gist.github.com/ggoodman/6c56e13ca097e0b89f7cf0f9214c8f30) and the [gondolin pi example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts), adapted as a standalone loadable pi extension.

## License

MIT
