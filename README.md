# Nostr TODO Bot

A TODO list bot for Nostr that runs on Cloudflare Workers.

## Features

- Manage personal TODO lists via Nostr mentions
- Per-user TODO numbering
- Web interface for viewing TODOs
- Profile information display with caching

## Commands

- `list` - Show all incomplete TODOs
- `add <content>` - Add a new TODO (supports multiline)
- `show <id>` - Display full TODO content
- `done <id>` - Mark TODO as completed
- `delete <id>` - Delete a TODO
- `search <keyword>` - Search TODOs by keyword
- `web` - Get web view URL

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create D1 database:
```bash
npx wrangler d1 create nostr-todo
```

3. Update `wrangler.jsonc` with your database ID

4. Apply database schema:
```bash
npx wrangler d1 execute nostr-todo --remote --file=schema.sql
```

5. Set environment variable:
```bash
npx wrangler secret put TODO_NSEC
```

6. Deploy:
```bash
npm run deploy
```

## Development

```bash
npm run dev
```

## License

MIT

## Authors

Yasuhiro Matsumoto (a.k.a. mattn)
