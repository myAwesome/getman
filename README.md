# Getman

Simple desktop API client for macOS, built with [Wails](https://github.com/wailsapp/wails).

## Features

- HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
- Custom request headers (add/remove rows)
- Raw request body editor
- Response status and duration
- Response headers and body viewer

## Requirements

- Go `>= 1.22` (Wails currently uses newer Go toolchains)
- Node.js + npm
- Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)

## Development

```bash
wails dev
```

## Build macOS app

```bash
wails build -clean
```

Output app bundle:

- `build/bin/getman.app`
