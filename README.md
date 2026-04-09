# Getman

Simple desktop API client for macOS, built with [Wails](https://github.com/wailsapp/wails).

## Features

- HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
- MySQL-backed workspace persistence (`collections`, `folders`, `requests`)
- Custom request headers (add/remove rows)
- Raw request body editor
- Response status and duration
- Response headers and body viewer

## Requirements

- Go `>= 1.22` (Wails currently uses newer Go toolchains)
- Node.js + npm
- MySQL `>= 8.0` (or compatible MySQL/MariaDB)
- Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)

## Database configuration

Set the DSN with `GETMAN_MYSQL_DSN`:

```bash
export GETMAN_MYSQL_DSN='user:password@tcp(127.0.0.1:3306)/getman?parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci'
```

If unset, the app defaults to:

```text
root:root@tcp(127.0.0.1:3306)/getman?parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci
```

The app will create the target database automatically on startup if it does not exist.

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
