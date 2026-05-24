# Free Antigravity CLI

**Open Source Community Edition** - A free, open-source CLI for Antigravity that supports custom AI models.

Supports **OpenAI, Anthropic, Ollama, OpenRouter, Google AI Studio, and any OpenAI-compatible provider** alongside Gemini models.

## Quick Start

```bash
# Install globally
npm install -g free-antigravity-cli

# Start interactive chat
antigravity chat

# Or use npx without installing
npx free-antigravity-cli chat
```

## Features

- **Custom AI Models**: Use OpenAI, Anthropic, Ollama, OpenRouter, and custom providers
- **Interactive Chat REPL**: Streaming AI chat right in your terminal
- **Model Management**: Add, remove, list, and import models via CLI
- **Local Proxy**: Built-in proxy server for IDE integration
- **API Key Encryption**: AES-256-CBC encryption for stored API keys
- **Community Owned**: Apache 2.0 license, fully open source

## Commands

```
antigravity chat                  # Interactive chat (default)
antigravity chat "prompt"         # One-shot prompt
antigravity models list           # List all models
antigravity models add            # Add a model (interactive)
antigravity models remove <name>  # Remove a model
antigravity models import         # Import from desktop Antigravity
antigravity proxy                 # Start proxy server
antigravity configure             # Show config info
```

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
antigravity chat
```

### npx (No Install)

```bash
npx free-antigravity-cli chat
```

### From Source

```bash
git clone https://github.com/vahapogut/free-antigravity-cli.git
cd free-antigravity-cli
npm install
npm run build
node dist/cli.js chat
```

## How It Works

```
Terminal (antigravity chat)
  → CLI sends Gemini-format request
  → Local proxy (port 50999) intercepts
    ├── Google models → daily-cloudcode-pa.googleapis.com
    └── Custom models → OpenAI / Anthropic / Ollama / etc.
  → Response translated back to Gemini format
  → Streaming output to terminal
```

The CLI includes a **built-in proxy server** that translates between Gemini format and provider-native formats:

- **OpenAI**: `Gemini ↔ OpenAI Chat Completions`
- **Anthropic**: `Gemini ↔ Anthropic Messages`
- **Ollama**: `Gemini ↔ OpenAI-compatible` (port 11434)
- **Google AI Studio**: Passthrough with URL routing
- **Custom**: OpenAI-compatible format

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
    }
  ]
}
```

## Comparison with Google's Official CLI

| Feature | Free Antigravity CLI | Google agy CLI |
|---|---|---|
| Open Source | Yes (Apache 2.0) | No |
| Custom Models | Yes | No |
| OpenAI | Yes | No |
| Anthropic (Claude) | Yes | No |
| Ollama (Local) | Yes | No |
| Gemini | Yes | Yes |
| Size | ~200 KB | 151 MB |
| npm Install | Yes | No |

## Contributing

Pull requests welcome! See the [GitHub repo](https://github.com/vahapogut/free-antigravity-cli).

## License

Apache License 2.0 - see LICENSE file for details.

## Author

**Vahap Ogut**

[GitHub](https://github.com/vahapogut)
