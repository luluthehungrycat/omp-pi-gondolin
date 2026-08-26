# OMP-Pi-Gondolin

> **Fork notice:** this repository is a downstream fork/port of the original [`pi-gondolin`](https://github.com/earendil-works/gondolin) plugin. It adapts the sandbox to the [Oh My Pi (OMP)](https://github.com/luluthehungrycat/omp) extension API while retaining the original Gondolin VM approach.

OMP-Pi-Gondolin runs OMP's tool calls (`bash`, `read`, `write`, `edit`, and `user_bash`) inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM instead of directly on the host. The working directory is mounted read-write at `/workspace` inside the VM.

## Experimental warning

This plugin is **experimental** and is **not compatible with an official stock Bun release yet**.

The verified compatibility path currently requires a locally source-built Bun from Bun PR [#39652](https://github.com/oven-sh/bun/pull/39652), source commit:

```text
1b93209a8a3ebead9ad8c56164d4358fc493a989
```

Stock Bun 1.4.0 aborts while importing Gondolin's `ssh2` dependency:

```text
unsupported uv function: uv_version_string
```

Do not work around this limitation with a network bypass, unsandboxed fallback, or weakened containment. Work to reduce or eliminate the Node.js/native dependency incompatibilities is underway. The current plan is to investigate a Bun-compatible Gondolin dependency path first; if that is not viable, a Node.js helper-process boundary or an alternative SSH implementation may be evaluated. The legacy Pi compatibility shim remains in place until an alternative implementation is created and proven.

Bun PR #39652 is **not an official Bun release**. This plugin must remain classified as experimental until equivalent compatibility is included in an official Bun release or the dependency path is independently made Bun-compatible.

## Requirements

- OMP 18.x
- A source-built Bun from Bun PR #39652 for the current verified path
- QEMU:
  - macOS: `brew install qemu`
  - Linux (x86_64): `sudo apt install qemu-system-x86`
  - Linux (aarch64): `sudo apt install qemu-system-arm`
- Gondolin 0.12.0 requires Node.js 23.6+ for its Node-based tooling and package engine requirements. OMP itself continues to run under Bun.

The verified Linux tests use QEMU TCG/software emulation; `/dev/kvm` is optional and is not required for the tested path.

## Install with OMP

### Public Git installation — no package token required

The public GitHub repository is the canonical no-token installation path:

```bash
omp plugin install git+https://github.com/luluthehungrycat/omp-pi-gondolin.git#main
omp plugin doctor
```

For an SSH-based Git setup:

```bash
omp plugin install git+ssh://git@github.com/luluthehungrycat/omp-pi-gondolin.git#main
```

### Optional GitHub Packages installation

GitHub Packages is optional. It is not required for public Git installation.

```bash
npm config set @luluthehungrycat:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GITHUB_TOKEN"
omp plugin install @luluthehungrycat/omp-pi-gondolin
omp plugin doctor
```

Never commit or print the token used for GitHub Packages authentication.

### Local development checkout

To test a local checkout without publishing it:

```bash
omp plugin link /path/to/omp-pi-gondolin
omp plugin doctor
```

## Running OMP with the local PR-39652 Bun build

OMP's launcher resolves `bun` through `PATH`, so the Bun runtime can be selected per invocation without replacing the global Bun installation.

If the source checkout was built in place and its debug binary is relocatable, create a user-local command name and launch OMP with a temporary PATH override:

```bash
mkdir -p ~/.local/omp-bun-39652/bin
ln -sf /path/to/bun-pr-39652-source/build/debug/bun-debug \
  ~/.local/omp-bun-39652/bin/bun

PATH="$HOME/.local/omp-bun-39652/bin:$PATH" omp
```

Use an isolated OMP profile while testing:

```bash
PATH="$HOME/.local/omp-bun-39652/bin:$PATH" \
  omp --profile gondolin-experimental
```

Build the Bun checkout from its own source directory before creating the link:

```bash
cd /path/to/bun-pr-39652-source
bun bd --version
```

The build requires the toolchain documented by Bun, including the required Clang version for the checkout.

### Relocated debug-build workaround on Linux

Some debug binaries are built with an absolute dynamic-module path such as `/root/bun`. If the binary reports that it cannot load bundled `node:*` modules from its original build path, rebuild it in the current checkout. If rebuilding is temporarily unavailable, a user-local `bwrap` shim can map the embedded path without modifying `/root` or installing Bun globally:

```bash
mkdir -p ~/.local/omp-bun-39652/bin
cat > ~/.local/omp-bun-39652/bin/bun <<'SH'
#!/bin/sh
set -eu
exec bwrap \
  --ro-bind / / \
  --tmpfs /root \
  --dir /root/bun \
  --ro-bind "$HOME/bun-pr-39652-source" /root/bun \
  --bind "$HOME" "$HOME" \
  --dev-bind /dev /dev \
  --proc /proc \
  --setenv HOME "$HOME" \
  --chdir "$PWD" \
  /root/bun/build/debug/bun-debug "$@"
SH
chmod +x ~/.local/omp-bun-39652/bin/bun

PATH="$HOME/.local/omp-bun-39652/bin:$PATH" omp --profile gondolin-experimental
```

This workaround is Linux-specific and requires `bubblewrap`. A clean in-place Bun rebuild is preferred.

## Usage

After installation or linking, start OMP from the project directory you want to protect:

```bash
cd /your/project
PATH="$HOME/.local/omp-bun-39652/bin:$PATH" omp \
  --profile gondolin-experimental
```

For an explicit local extension path:

```bash
cd /your/project
PATH="$HOME/.local/omp-bun-39652/bin:$PATH" omp \
  --profile gondolin-experimental \
  --extension /path/to/omp-pi-gondolin/index.ts
```

On first run, Gondolin downloads its guest image into the configured Gondolin cache, usually under `~/.cache/gondolin/`.

## What it does

- **Routes `bash`** — commands run through `/bin/bash -lc` inside the VM.
- **Routes `read`** — files are read from the VM's `/workspace` tree.
- **Routes `write` and `edit`** — writes execute through the VM filesystem and synchronize through the mounted workspace.
- **Routes `user_bash`** — explicit user shell commands remain inside the VM.
- **Enforces workspace boundaries** — paths outside the mounted workspace are denied.
- **Patches the system prompt** — the model is told that its working directory is `/workspace`.
- **Starts and stops cleanly** — the VM starts on session startup or first tool use and closes with the OMP session.

## How it works

Gondolin boots a lightweight QEMU micro-VM. Its `RealFSProvider` exposes the selected host workspace through a virtual filesystem, while `vm.exec()` runs commands in the guest. OMP-Pi-Gondolin adapts those VM operations to OMP 18's extension and tool interfaces.

The port deliberately keeps the legacy Pi compatibility shim while the replacement dependency work is investigated. That shim will not be removed until a replacement path has passed equivalent registration, tool, lifecycle, and containment tests.

## Verification status

The strongest verified combination is:

```text
OMP: 18.0.4
Gondolin: 0.12.0
Bun: Bun PR #39652 source build
Bun commit: 1b93209a8a3ebead9ad8c56164d4358fc493a989
QEMU: TCG/software emulation
```

Verified gates include OMP extension registration, VM startup/shutdown, `read`/`write`/`edit`, `bash`, `user_bash`, workspace synchronization, outside-workspace denial, host-path invisibility, and adversarial containment probes.

## License

MIT
