# ed-api-client

A TypeScript port of the unofficial Ed API wrapper with first-class support for Node.js and browser environments. The client ex
poses a small, promise-based surface area and a websocket event system so you can automate responses to new posts, comments, and
course activity.

## Features
- Typed client with `createEdAPIClient` factory for ergonomic configuration.
- Works in both Node.js (via Bun, Node 18+, etc.) and browser contexts.
- Automatic websocket reconnection with message queueing.
- Event-driven API covering thread, comment, and course presence events.
- Helpers for fetching courses and individual threads.

## Installation
The project is built with [Bun](https://bun.sh/). Install dependencies with:

```bash
bun install
```

To produce a distributable build (ESM + `.d.ts` typings):

```bash
bun run build
```

## Quick start
```ts
import { createEdAPIClient } from 'ed-api-client';

const client = createEdAPIClient({
  apiKey: process.env.ED_API_TOKEN!,
  region: 'au',
  // Optional:
  // fetchImpl: customFetch,
  // WebSocketImpl: customWebSocket,
  // baseUrl: 'https://au.edstem.org',
  // websocketUrl: 'wss://au.edstem.org',
});

const courses = await client.getCourses();
console.log('You have access to:', courses.map((course) => course.name));

client.on('thread.new', async ({ thread }) => {
  console.log(`New thread posted: #${thread.number} ${thread.title}`);
});

await client.subscribe(); // Subscribe to all available courses.
```

### Using Node.js with the `ws` package
```ts
import WebSocket from 'ws';
import { createEdAPIClient } from 'ed-api-client';

const client = createEdAPIClient({
  apiKey: process.env.ED_API_TOKEN!,
  region: 'au',
  WebSocketImpl: WebSocket as unknown as typeof WebSocket,
});
```

### Selecting courses
Pass either a single ID or an array to `subscribe` to scope the websocket connection:

```ts
await client.subscribe([12345, 67890]);
```

### Fetching a thread
```ts
const thread = await client.getThread(42);
console.log(thread.thread.title);
```

### Shutting down
```ts
await client.close();
```

## Configuration reference
| Option | Description | Default |
| --- | --- | --- |
| `apiKey` | Ed API token used for both HTTP and websocket auth. | **required** |
| `region` | Region slug for the Ed deployment (`'au'`, `'us'`, `'eu'`). | `'au'` |
| `baseUrl` | HTTPS endpoint override. | `https://<region>.edstem.org` |
| `websocketUrl` | WebSocket endpoint override. | `wss://<region>.edstem.org` |
| `fetchImpl` | Custom `fetch` implementation (useful in Node < 18). | `globalThis.fetch` |
| `WebSocketImpl` | Custom `WebSocket` constructor (pass the `ws` package in Node). | `globalThis.WebSocket` |
| `logger` | Object implementing `debug`, `info`, `warn`, `error`. | `console` |
| `reconnectDelayMs` | Delay before reconnecting the websocket. | `5000` |

## Events
Register listeners with `client.on(eventName, handler)`:

- `thread.new`
- `thread.update`
- `thread.delete`
- `comment.new`
- `comment.update`
- `comment.delete`
- `course.count`

Each handler receives a typed payload defined in [`src/types.ts`](./src/types.ts).

## Legacy Python implementation
The original Python source has been kept under [`./edpy`](./edpy) for historical reference only. The new TypeScript client is the
implementation that is actively maintained in this repository.
