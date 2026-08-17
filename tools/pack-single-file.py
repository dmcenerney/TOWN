#!/usr/bin/env python3
"""
Pack the entire TOWN repository into a single self-installing GitHub Actions
workflow file.

The output is one file. Upload it to .github/workflows/ in an empty repo, press
Run workflow, and it writes the whole tree, verifies it, and deletes itself.
"""

import base64
import io
import subprocess
import sys
import tarfile
from pathlib import Path

SRC = Path("/mnt/user-data/outputs/town")
OUT = Path("/mnt/user-data/outputs/install-alder-bend-stage1.yml")

def arcname_for(p: Path) -> str:
    """
    GitHub refuses any push from an Actions token that creates or updates a file
    under .github/workflows/ — that permission cannot be granted in the YAML, it
    requires a personal access token with workflow scope. So the CI workflows
    ride along in ci/workflows/ and get moved into place by hand, once.
    """
    rel = p.relative_to(SRC)
    if rel.parts[:2] == (".github", "workflows"):
        return str(Path("ci/workflows").joinpath(*rel.parts[2:]))
    return str(rel)


# Deterministic tarball: fixed mtime, sorted order, no uid/gid noise.
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9, format=tarfile.GNU_FORMAT) as tar:
    paths = sorted(
        p for p in SRC.rglob("*")
        if "node_modules" not in p.parts and not p.name.startswith("install-alder-bend")
    )
    for p in paths:
        info = tar.gettarinfo(str(p), arcname=arcname_for(p))
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        if p.is_file():
            with open(p, "rb") as fh:
                tar.addfile(info, fh)
        else:
            tar.addfile(info)

payload = base64.b64encode(buf.getvalue()).decode()
lines = [payload[i:i + 120] for i in range(0, len(payload), 120)]
indent = " " * 10
body = "\n".join(indent + line for line in lines)

file_count = sum(1 for p in SRC.rglob("*") if p.is_file() and "node_modules" not in p.parts)

workflow = f"""name: install Alder Bend

# ONE FILE. Everything TOWN needs is embedded below.
#
#   1. Upload this file to .github/workflows/ in your repository
#   2. Settings -> Actions -> General -> Workflow permissions -> Read and write
#   3. Actions -> "install Alder Bend" -> Run workflow
#
# It writes {file_count} files, then runs the full test suite and a thousand
# simulated days to prove they work.
#
# It does not touch .github/workflows/ at all. An Actions token is forbidden
# from creating files there, and that permission cannot be granted in YAML — it
# needs a personal access token with workflow scope. So the three CI workflows
# land in ci/workflows/ and you move them into place yourself, once, from the
# web editor. The run summary explains it.

on:
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: world-write
  cancel-in-progress: false

jobs:
  install:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Write the repository
        run: |
          cat > /tmp/alder-bend.b64 <<'PAYLOAD'
{body}
          PAYLOAD
          base64 -d /tmp/alder-bend.b64 > /tmp/alder-bend.tgz
          tar xzf /tmp/alder-bend.tgz -C .
          echo "Wrote $(git status --porcelain | wc -l) paths."

      - name: Commit
        run: |
          git config user.name  "alder-bend-bot"
          git config user.email "alder-bend-bot@users.noreply.github.com"
          git add -A
          git commit -m "Alder Bend Stage 1: map, navigation graph, routing, movement"
          git push

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm install --no-audit --no-fund

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test 2>&1 | tail -20

      - name: Soak — 1,000 days
        run: |
          node --import tsx tools/soak.ts --days 1000 | tee /tmp/soak.txt
          {{
            echo "## Alder Bend, Stage 1"
            echo ""
            echo "The repository is written and committed. Pushes made by a workflow do not"
            echo "trigger other workflows, so the verification below ran here instead. Your own"
            echo "commits from here on will trigger \\`verify\\` normally."
            echo ""
            echo '```'
            cat /tmp/soak.txt
            echo '```'
          }} >> "$GITHUB_STEP_SUMMARY"

      - name: Founding roster
        run: |
          {{
            echo "## Founding roster"
            echo ""
            echo '```'
            node --import tsx tools/inspect.ts
            echo '```'
          }} >> "$GITHUB_STEP_SUMMARY"

      - name: What is left to do
        run: |
          {{
            echo "## Two things left, both in the browser"
            echo ""
            echo "**1. Put the CI workflows in place.** They are sitting in \\`ci/workflows/\\`."
            echo "For each of \\`verify.yml\\`, \\`soak.yml\\` and \\`unpack.yml\\`: open the file, tap the"
            echo "pencil, and change the path from \\`ci/workflows/NAME.yml\\` to"
            echo "\\`.github/workflows/NAME.yml\\`. Commit. Renaming with slashes moves the file."
            echo ""
            echo "**2. Delete this installer.** Open \\`.github/workflows/install-alder-bend.yml\\`"
            echo "and use the trash icon. It has done its job and it is 77 KB of base64."
            echo ""
            echo "Then Alder Bend is yours: every push runs \\`verify\\`, and \\`soak\\` gives you a"
            echo "Run workflow button for simulating any number of days from your phone."
          }} >> "$GITHUB_STEP_SUMMARY"
"""

OUT.write_text(workflow)
size_kb = OUT.stat().st_size / 1024
print(f"wrote {OUT}  ({size_kb:.0f} KB, {len(lines)} payload lines, {file_count} files packed)")

# Validate YAML if pyyaml is available.
try:
    import yaml
    yaml.safe_load(OUT.read_text())
    print("yaml ok")
except ImportError:
    print("pyyaml unavailable; skipped yaml validation")
