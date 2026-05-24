# Free Antigravity CLI

**Open Source Community Edition** - Wraps the official [Antigravity CLI](https://antigravity.google/cli) (`agy`) with custom AI model support.

Use **OpenAI, Anthropic, Ollama, OpenRouter, Google AI Studio, and any OpenAI-compatible provider** alongside Gemini models -- all through the native `agy` CLI experience.

## How It Works

```
antigravity
  ├── Starts local proxy (port 50999)
  ├── Auto-patches agy.exe to route through proxy
  └── Delegates to agy CLI
        ├── Google models → daily-cloudcode-pa.googleapis.com (transparent)
        └── Custom models → injected by proxy into model list
```

The CLI is a thin wrapper: it starts a local HTTP proxy that intercepts `fetchAvailableModels` API calls, injects your custom model definitions, then hands off to the official `agy` CLI. You get the full native Antigravity CLI experience plus custom models.

## Quick Start

```bash
# 1. Install official Antigravity CLI first
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd

# 2. Install Free Antigravity CLI
npm install -g free-antigravity-cli

# 3. Add your custom models
antigravity models add

# 4. Start chatting (all models appear in agy's model selector)
antigravity
```

## Prerequisites

- **Node.js** >= 18
- **Official Antigravity CLI** (`agy`) installed at `%LOCALAPPDATA%\agy\bin\agy.exe`

## Commands

```
antigravity              Start interactive chat (proxy + agy)
antigravity chat         Same as above
antigravity models list  List configured custom models
antigravity models add   Add a new custom model (interactive wizard)
antigravity models remove <name>  Remove a custom model
antigravity models import  Import models from desktop Antigravity
antigravity configure    Show configuration info
antigravity version      Show version
antigravity help         Show this help
```

Any arguments not listed above are passed directly to `agy` CLI.

## Supported Providers

| Provider | CLI Value | Auth |
|---|---|---|
| OpenAI | `openai` | API Key (`sk-...`) |
| Anthropic | `anthropic` | API Key (`sk-ant-...`) |
| Google AI Studio | `google` | API Key (`AIza...`) |
| Ollama (Local) | `ollama` | None |
| OpenRouter | `openrouter` | API Key |
| Custom (OpenAI-compatible) | `custom` | API Key |

## Installation

### npm (Recommended)

```bash
npm install -g free-antigravity-cli
antigravity
```

### From Source

```bash
git clone https://github.com/vahapogut/free-antigravity-cli.git
cd free-antigravity-cli
npm install
npm run build
npm link
antigravity
```

## Configuration

Models are stored in `~/.free-antigravity/models.json`:

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o (OpenAI)",
      "provider": "openai",
      "apiKey": "sk-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o"
    },
    {
      "name": "models/claude-opus-4-7",
      "displayName": "Claude Opus 4.7",
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-opus-4-7"
    },
    {
      "name": "models/llama3",
      "displayName": "Llama 3 (Local)",
      "provider": "ollama",
      "apiKey": "none",
      "apiUrl": "http://localhost:11434/v1/chat/completions",
      "externalModelName": "llama3"
    }
  ]
}
```

### Importing from Desktop Antigravity

```bash
antigravity models import
```

> **NOTE:** API keys from the desktop app are encrypted with Electron's `safeStorage` and cannot be decrypted by the CLI. After importing, re-enter your API keys via `antigravity models add`.

## Technical Details

### Binary Patching

On first run, the CLI automatically patches `agy.exe` to replace the hardcoded Google API URL:

```
https://daily-cloudcode-pa.googleapis.com
→ http://localhost:50999/v1internal/xxxxxxx
```

This forces `agy` to route its `fetchAvailableModels` calls through the local proxy, where custom model definitions are injected.

The original binary is backed up at `agy.exe.bak`.

### Proxy Server

The proxy runs on `http://127.0.0.1:50999` (falls back to dynamic port if busy) and:

1. **Intercepts `fetchAvailableModels`**: Merges custom model definitions into the response
2. **Intercepts `generateContent`/`streamGenerateContent`**: Routes custom model requests to external APIs
3. **Translates formats**: Gemini ↔ OpenAI / Anthropic / Ollama / Google AI Studio
4. **Transparent forwarding**: All other requests pass through to Google unchanged

### Provider Translation

| Provider | Request Translation | Response Translation | Streaming |
|---|---|---|---|
| OpenAI | Gemini → Chat Completions | Chat Completions → Gemini | SSE delta → Gemini chunks |
| Anthropic | Gemini → Messages API | Messages → Gemini | SSE events → Gemini chunks |
| Ollama | Gemini → OpenAI-compatible | OpenAI → Gemini | Same as OpenAI |
| Google AI Studio | Passthrough (native Gemini) | Passthrough | SSE chunks |
| OpenRouter | Same as OpenAI | Same as OpenAI | Same as OpenAI |
| Custom | Same as OpenAI | Same as OpenAI | Same as OpenAI |

## Comparison

| Feature | Free Antigravity CLI | Google agy CLI |
|---|---|---|
| Open Source | Yes (Apache 2.0) | No |
| Custom Models | Yes | No |
| OpenAI / Anthropic / Ollama | Yes | No |
| Gemini | Yes | Yes |
| All agy Features | Yes (wraps agy) | Yes |
| Size | ~90 KB | 151 MB |
| npm Install | Yes | No |
| Auto-updates | Via npm | Built-in |

## Contributing

Pull requests welcome at [github.com/vahapogut/free-antigravity-cli](https://github.com/vahapogut/free-antigravity-cli).

## License

Apache License 2.0 - see [LICENSE](LICENSE).

## Author

**Vahap Ogut** - [GitHub](https://github.com/vahapogut)
