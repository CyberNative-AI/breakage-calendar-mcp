# Breakage Calendar MCP server

[![CyberNative-AI/breakage-calendar-mcp MCP server](https://glama.ai/mcp/servers/CyberNative-AI/breakage-calendar-mcp/badges/score.svg)](https://glama.ai/mcp/servers/CyberNative-AI/breakage-calendar-mcp)

`check docker:postgres:latest pypi:celery==5.4.0 pypi:langsmith runner:macos-14` → **`postgres:latest` is due to move to 19 on 19 November 2026: HITS, tested fix (pin `postgres:18`; we ran it on 13 November).** The macOS 14 runner was retired on 2 November: HITS. `langsmith`'s evaluator sends `gpt-4o` by default, and OpenAI removes the snapshots `gpt-4o` points to on 14 January 2027: MAY HIT. Celery beat paused for the repeated hour in our tests when US clocks went back on 1 November: MAY HIT, tested fix.
That is this server's real answer on 13 November 2026 (five dates in all), from the [Breakage Calendar](https://cybernative.ai/breakage-calendar/): 65 dated upstream changes that break working software, each with the check that finds it and, for 29 of them, a fix we ran ourselves.

An MCP server (and a command) for coding agents that upgrade, pin or deploy a project. It answers: **which dated breaks hit this repository or this dependency list, and what is the tested fix?** No key, no account, no dependencies.

**Prefer an agent skill?** Use it in your coding agent: [dated-breaks-skill](https://github.com/CyberNative-AI/dated-breaks-skill), a `SKILL.md` folder and one Python script (standard library only), with no MCP setup.

## Install

Node.js 18.17 or later. Every client starts the same command:

```
npx -y github:CyberNative-AI/breakage-calendar-mcp
```

**Claude Code** (from the project folder, so `check_repository` can read it):

```
claude mcp add breakage-calendar -- npx -y github:CyberNative-AI/breakage-calendar-mcp
```

**Claude Desktop, Cursor, Windsurf, Cline** and other clients with an `mcpServers` JSON file:

```json
{
  "mcpServers": {
    "breakage-calendar": {
      "command": "npx",
      "args": ["-y", "github:CyberNative-AI/breakage-calendar-mcp"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "breakage-calendar": { "type": "stdio", "command": "npx", "args": ["-y", "github:CyberNative-AI/breakage-calendar-mcp"] }
  }
}
```

To pin a release, write `github:CyberNative-AI/breakage-calendar-mcp#v0.1.0`.

**Without MCP**, the same answers on the command line:

```
npx -y github:CyberNative-AI/breakage-calendar-mcp check docker:postgres:latest pypi:celery==5.4.0
npx -y github:CyberNative-AI/breakage-calendar-mcp repo .
npx -y github:CyberNative-AI/breakage-calendar-mcp upcoming 90
```

## Tools

| Tool | What it answers |
|---|---|
| `check_repository` | Reads a local project folder and runs every date's published search over its files: which dates hit it, on which line, and the fix. |
| `check_dependencies` | The same for a list such as `docker:postgres:latest`, `pypi:celery==5.4.0`, `npm:cron@3.1.7`, `gem:rails@8.0.2`, `go:golang.org/x/crypto@v0.31.0`, `maven:com.jcraft:jsch`, `action:actions/setup-python@v5`, `runner:macos-14`, `brew:node@18`, `model:gpt-4o`, `cran:decoupleR`. Also names the libraries we found sending a retiring AI model when you do not choose one. |
| `check_files` | The same for file contents the agent passes (`package.json`, `requirements.txt`, `compose.yaml`, `Dockerfile`, `.github/workflows/*.yml`, `Gemfile.lock`, …), for a server that cannot read the folder. |
| `list_upcoming_breaks` | Dates still to come, by area (`AI APIs`, `CI runners`, `Time zones`, …) or word. |
| `get_break` | One date in full: what changes, who is affected, the check command, the fix, and the vendor sources with the day we last read each. |

Each finding says **HITS** (the search matched a line that uses what changes) or **MAY HIT** (it is used, and only some setups break; the entry's check tells which). Dates that took effect in the last 30 days are included, because a project still on the old line is already broken.

## What it adds to endoflife.date and a web search

[endoflife.date](https://endoflife.date/) tells an agent when a version stops getting updates. A web search finds an announcement once the agent knows what to search for. Neither tells it that `postgres:latest` moves to 19 on 19 November 2026, and that a stack already holding 18's data then stops starting. This calendar records the day something **stops working**, which is often not an end-of-life date at all: an image tag that moves to a new major version, a model that a library sends by default, a CI runner label that is retired, a time-zone rule that changes. For each date it gives:

- the search that finds it in a repository's files, run for you; for dates a repository cannot show (a running server, a clock, a certificate), the check to run where it lives;
- who is and is not affected, from our own tests where we ran them;
- the fix: one we ran, with the day we ran it, or a guide, or, where we have neither, the vendor's notice and the words "no tested fix yet";
- the vendor's own notices, each with the day we last read it.

On 13 November 2026 that was 65 dates: 49 with a repository search, and 29 with a fix we ran. It does not replace either source: it covers the dates we have researched, not every version of every product. For a product's support dates, ask endoflife.date.

## What it reads and sends

- It fetches two files, by GET with no body: `https://cybernative.ai/breakage-calendar/entries.json` and `https://cybernative.ai/breakage-calendar/check/signatures.json`, with the user agent `breakage-calendar-mcp/0.1.0 (+https://github.com/CyberNative-AI/breakage-calendar-mcp)`, and refuses redirects. It keeps them in memory and asks again after an hour (with `If-None-Match`). Like any web request, these show our server your IP address and the time. **Nothing from your project, dependency list or files is sent.**
- `check_repository` reads text files up to 1 MB, at most 20,000 files, skipping `.git`, `node_modules`, virtual environments and build output, and does not follow symlinks. It reads only inside the folder the server was started in, and any folders listed in `BREAKAGE_CALENDAR_ROOTS` (separated by `:`; `;` on Windows). Started with `--roots` (`npx -y github:CyberNative-AI/breakage-calendar-mcp --roots ~/code/app ~/code/api`), it reads only the folders given after it, and no folder if none is given.
- The searches come from the calendar files, so they run in a separate thread with a 2-minute deadline and a 256 MB heap limit.
- If cybernative.ai cannot be reached, the tools say so; after a first successful read they keep answering from that copy and say it is stale. There is no bundled copy of the dates.

Agents and scripts that do not use MCP can read the same public JSON directly: [entries.json](https://cybernative.ai/breakage-calendar/entries.json) (every date) and [check/signatures.json](https://cybernative.ai/breakage-calendar/check/signatures.json) (the searches).

## Limits

- A search finds what a repository's files show. Dates that depend on a server, a certificate, a clock or a browser are listed as such, with their own check.
- `check_dependencies` turns each item into the line a manifest would hold, so a version-specific date matches only when you give the version.
- MAY HIT means "read the check": in our tests only some versions or settings broke.

## Development

```
npm test
```

No dependencies. `src/match.js` is a byte copy of the matcher that [the in-browser check](https://cybernative.ai/breakage-calendar/check/) runs, so both give the same answer for the same files.

Built and maintained by **CyberNative AI LLC**, an AI-run company with one human founder. This server, the calendar and this README were written by AI agents. Report a wrong or missing date as an issue here, or to hello@cybernative.ai. Apache License 2.0.
