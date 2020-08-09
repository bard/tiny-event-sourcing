# Tiny Event Sourcing

Minimalist zero-setup event sourcing infrastructure geared at prototyping and early data model exploration.

## Motivation

In the early stages of developing a service, you're probably not sure what data to capture and what to leave out. If you capture a lot just in case, figuring where it all fits in the data model (and each of its iterations) becomes a burden that is hard to justify for potentially useless information; if you leave out a lot, you might later realize you needed it.

The Event Sourcing architecture has a property that is invaluable at this stage: it allows to capture information and delay organizing it until it's needed. Everything that happens in the system is represented as _events_ that are appended to a durable and immutable _log_. _Subscribers_ receive events and build _read models_ based on them. Read models are queried to e.g. present information to the user.

At any point in development, you can stop the system, modify the event subscribers so that they start using a dormant piece of data, replay the log, let subscribers rebuild the read models, and it will be as if **you had known how to use that information since day #1**.

This library lets you quickly structure a prototype around Event Sourcing. It has zero runtime dependencies on other services (saves both log and state snapshots to disk files) and makes no attempt at being suitable for production (read models are kept entirely in memory and there is no log compaction).

## How to use

The 10000ft view:

1. define one or more domain events
2. initialize the event log
3. define one or more read models
4. initialize a state store for each read model
5. process past and future events
6. get events into the system

Say you're building a bookmarking service; user can POST web page URLs; the service fetches additional information such as title and favicon URLs. Here's how it could look like (in TypeScript — ignore types if you're using plain JavaScript):

### 1. Define domain events

```typescript
interface BookmarkEvent {
  type: 'bookmark'
  url: string
}

interface InfoEvent {
  type: 'info'
  url: string
  title: string
  faviconUrl: string
}

type DomainEvent = BookmarkEvent | InfoEvent
```

### 2. Initialize the event log

```typescript
import { initLog } from 'tiny-event-sourcing'

const log = await initLog<DomainEvent>({
  filename: '/tmp/bookmark-service/log.ndjson',
})
```

### 3. Define read models

```typescript
interface BookmarksReadModel {
  byUrl: {
    [url: string]: {
      url: string
      title: string
      faviconUrl: string
    }
  }
}

interface InfoFetcherReadModel {
  // no specific state here
}
```

### 4. Initialize state stores for each read model

```typescript
import { initStateStore } from 'tiny-event-sourcing'

const bookmarksReadModel = await initStateStore<BookmarksReadModel>({
  filename: '/tmp/example/read-model.json',
})

const infoFetcherReadModel = await initStateStore<InfoFetcherReadModel>({
  filename: '/tmp/example/info-fetcher.json',
})
```

### 5. Process events

```typescript
import { catchupSubscribe } from 'tiny-event-sourcing'
import { fetchPageInfo } from 'some-http-library'

catchupSubscribe(log.events(), async (event) => {
  // Skip already processed events

  if (bookmarksReadModel.getVersion() <= event.index) {
    return
  }

  // Events of type "bookmark" will come from a REST API
  // endpoint below

  if (event.type === 'bookmark') {
    const { url } = event
    const { title, faviconUrl } = await fetchPageInfo(url)

    // Append the page information to the log so it can
    // be processed

    log.append({ type: 'info', url, title, faviconUrl })

    // The info fetcher isn't storing any state so just bump the version

    infoFetcherReadModel.update(infoFetcherReadModel.getState(), event.index)
  }
})

catchupSubscribe(log.events(), async (event) => {
  if (readModel.getVersion() <= event.index) {
    return
  }

  if (event.type === 'info') {
    const oldState = readModel.getState()

    // Create new state based on old state plus event

    const newState = {
      ...oldState,
      byUrl: {
        ...oldState.byUrl,
        [event.url]: {
          url: event.url,
          title: event.title,
          faviconUrl: event.faviconUrl,
        },
      },
    }

    // Store new state and bump version

    readModel.update(newState, event.index)
  }
})
```

### 6. Get events into the system

Events of type `info` are already generated above, but `bookmark` events are what sets everything in motion:

```typescript
import express from 'express'

const app = express()

app.post('/bookmarks', express.json(), (req, res) => {
  log.append({ type: 'bookmark', url: req.body.url })
  res.status(202).end()
})
```

## Tips

The [jq](https://stedolan.github.io/jq/) tool comes in handy when you're experimenting with event format and need to modify events already stored in the log. Use the `-c` flag to output ndjson format.

The [Flux Standard Action](https://github.com/redux-utilities/flux-standard-action#flux-standard-action) format works well for events: instead of `interface BookmarkEvent { type: 'bookmark', url: string }` as per the simplistic example above, consider using `interface BookmarkEvent { type: 'bookmark', payload: { url: string }}`.

`catchupSubscribe` is just a convenience function over the `log.events()` asynchronous iterator. If you want finer control over pulling past events and listening for new ones, you can use the full form: `for await(const event of events) { ... }`.

State files are just envelopes around the actual state data. Currently,l they only contain a `_version` field: `{ "_version": 123, "state": { ... }}`. The version doesn't increment uniformly, instead it reflects the index of the last processed event.

## License

MIT

## Author

[Massimiliano Mirra](https://massimilianomirra.com/)
